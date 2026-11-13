"""``SearchIntelligenceContract`` -- one canonical interface, three real
callers that could (future work) all satisfy it.

Checkpoint 1's BASELINE_L0 census found THREE existing, independently
implemented search paths in this repo:

  A. Production Next.js ``GET /api/media`` -- ILIKE across title/sku/
     brand/category/space/suggested_caption/keywords, synonym-expanded,
     sorted only by usage_count/created_at (no relevance ranking).
     (``src/app/api/media/route.ts`` -> ``listNativeLibraryMedia``.)
  B. The Python MCP agent server's lexical path -- a PostgREST-style ILIKE
     ``or=(...)`` filter over title/sku/brand/description, no synonym
     expansion. (``backend/verity_dam_mcp/server.py``,
     ``media_list_library()``.)
  C. The local JS demo-mode fallback -- plain ``.includes()`` substring
     match, no synonym expansion. (``src/lib/server/demo-media.ts``,
     ``matchesQuery()``.)

None of the three is rewritten in this checkpoint. This module documents
the interface all three COULD implement so they eventually call the same
ranking/recovery behavior, and provides the one reference implementation
(:func:`run_canonical_search`) that actually exists today, composed
purely from this checkpoint's own offline modules (normalize -> entity
extraction -> exact channel -> field-weighted lexical scoring -> RRF
fusion against an (always-empty-today) semantic channel -> deterministic
rerank). Parity fixtures in
``backend/tests/test_search_contract.py`` show, for a handful of
query/document inputs, how the CANONICAL engine ranks them, and document
where that already diverges from what the three existing paths do today
(see each fixture's comment).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Sequence

from .entity_extractor import EntityExtractionResult, extract_entities
from .exact_channel import compute_exact_signals, rank_tier
from .fuzzy_channel import generate_fuzzy_query_variants
from .lexical_scorer import score_document
from .query_classifier import QueryClassification, RuleBasedQueryClassifier
from .reranker import RerankCandidate, RerankedResult, rerank
from .rrf_fusion import HYBRID_BASELINE_RRF, RankedChannelHit, reciprocal_rank_fusion
from .search_document import SearchDocument
from .semantic_adapter import NullSemanticRetriever, SemanticRetriever, validate_semantic_hits
from .vietnamese_normalizer import NormalizedQuery, normalize_query


class SearchIntelligenceContract(Protocol):
    """The interface every real search entry point could implement.

    ``documents`` MUST already be the caller's permission-eligible
    candidate set -- this contract performs NO authorization of its own
    (see ``docs/search/PERMISSION_ORDER.md``: eligible-candidate-set ->
    ranking, never the reverse, unless the caller separately proves no
    excluded result can leak).
    """

    def search(
        self, raw_query: str, documents: Sequence[SearchDocument], *, top_k: int
    ) -> tuple[RerankedResult, ...]: ...


@dataclass(frozen=True)
class CanonicalSearchResult:
    normalized: NormalizedQuery
    entities: EntityExtractionResult
    classification: QueryClassification
    ranked: tuple[RerankedResult, ...] = field(default_factory=tuple)


def run_canonical_search(
    raw_query: str,
    documents: Sequence[SearchDocument],
    *,
    top_k: int = 20,
    semantic_retriever: SemanticRetriever = NullSemanticRetriever(),
) -> CanonicalSearchResult:
    """The one reference implementation of :class:`SearchIntelligenceContract`
    that exists today -- pure, offline, no DB, no permission check
    (``documents`` must already be permission-filtered by the caller).
    """

    normalized = normalize_query(raw_query)
    entities = extract_entities(normalized)
    classification = RuleBasedQueryClassifier().classify(normalized, entities)

    # Lexical channel: score every candidate document.
    lexical_scores = {document.asset_id: score_document(document, normalized) for document in documents}
    lexical_ranked = sorted(
        (RankedChannelHit(asset_id=asset_id, rank=0) for asset_id in lexical_scores),
        key=lambda hit: (-lexical_scores[hit.asset_id].total, hit.asset_id),
    )
    lexical_ranked = tuple(
        RankedChannelHit(asset_id=hit.asset_id, rank=index + 1) for index, hit in enumerate(lexical_ranked)
    )
    lexical_rank_by_id = {hit.asset_id: hit.rank for hit in lexical_ranked}

    # Semantic channel: interface only -- NullSemanticRetriever always
    # returns (), so this is exercised end-to-end without invoking any
    # real model. Every hit is passed through validate_semantic_hits()
    # BEFORE it ever reaches fusion -- this engine must never directly
    # trust a SemanticRetriever's raw output, even while the only real
    # implementation is a no-op (a future real retriever plugs into this
    # exact same call site without any caller change).
    raw_semantic_hits = tuple(semantic_retriever.retrieve(normalized, top_k=HYBRID_BASELINE_RRF.semantic_depth))
    semantic_hits = validate_semantic_hits(raw_semantic_hits)
    semantic_ranked = tuple(RankedChannelHit(asset_id=hit.asset_id, rank=hit.semantic_rank) for hit in semantic_hits)
    semantic_rank_by_id = {hit.asset_id: hit.rank for hit in semantic_ranked}

    rrf_results = reciprocal_rank_fusion(lexical_ranked, semantic_ranked)
    rrf_score_by_id = {result.asset_id: result.rrf_score for result in rrf_results}

    # Fuzzy channel: bounded rewritten-query variants; a document's fuzzy
    # signal is "did any variant's corrected token literally appear in
    # this document's own text" -- kept simple/explainable rather than
    # re-scoring every variant against every document.
    fuzzy_expansion = generate_fuzzy_query_variants(normalized)

    candidates: list[RerankCandidate] = []
    for document in documents:
        signals = compute_exact_signals(document, normalized, entities)
        tier = rank_tier(signals)
        lexical = lexical_scores[document.asset_id]

        fuzzy_confidence = 0.0
        fuzzy_candidate = None
        correction_used = None
        doc_text_fold = " ".join(
            [document.title, document.sku, document.brand, document.category, document.space]
        ).casefold()
        for variant in fuzzy_expansion.variants:
            if variant.candidate.corrected_token.casefold() in doc_text_fold:
                if variant.candidate.confidence > fuzzy_confidence:
                    fuzzy_confidence = variant.candidate.confidence
                    fuzzy_candidate = variant.candidate
                    correction_used = variant.candidate.corrected_token

        entity_values = {
            match.value.casefold()
            for group in (entities.brands, entities.categories, entities.spaces, entities.installation_contexts, entities.features, entities.protocols)
            for match in group
        }
        doc_entity_values = {
            value.casefold() for value in (document.brand, document.category, document.space) if value
        }
        overlap = len(entity_values & doc_entity_values) / len(entity_values) if entity_values else 0.0

        # Gap B (PR #31 review 5109220215): a document may enter final
        # ranking ONLY if it carries at least one POSITIVE retrieval
        # signal -- a structural exact/entity tier, a positive lexical
        # score, positive fuzzy evidence, or a valid semantic hit. Being
        # merely present in ``documents`` (the caller's permission-eligible
        # candidate set) is NOT evidence of relevance by itself; without
        # this gate every candidate document ranked regardless of whether
        # anything about it actually matched the query, so a controlled
        # nonsense query against a broad eligible set would return
        # asset-id-ordered noise instead of an honest empty result.
        has_positive_evidence = (
            signals.any_exact()
            or lexical.total > 0
            or fuzzy_confidence > 0
            or semantic_rank_by_id.get(document.asset_id) is not None
        )
        if not has_positive_evidence:
            continue

        candidates.append(
            RerankCandidate(
                asset_id=document.asset_id,
                rank_tier=tier,
                exact_signals=signals,
                lexical_score=lexical.total,
                fuzzy_confidence=fuzzy_confidence,
                fuzzy_candidate=fuzzy_candidate,
                correction_used=correction_used,
                rrf_score=rrf_score_by_id.get(document.asset_id, 0.0),
                lexical_rank=lexical_rank_by_id.get(document.asset_id),
                semantic_rank=semantic_rank_by_id.get(document.asset_id),
                query_type=classification.query_type.value,
                entity_overlap=overlap,
            )
        )

    ranked = rerank(candidates)[:top_k]
    return CanonicalSearchResult(normalized=normalized, entities=entities, classification=classification, ranked=ranked)
