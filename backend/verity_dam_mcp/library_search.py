"""Shared deterministic text-search workflow for the MCP media library."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from search_intelligence.contract import CanonicalSearchResult, run_canonical_search
from search_intelligence.fuzzy_channel import generate_fuzzy_query_variants
from search_intelligence.search_document import SearchDocument
from search_intelligence.vietnamese_normalizer import normalize_query


@dataclass(frozen=True)
class RankedLibraryPage:
    rows: tuple[dict[str, Any], ...]
    total: int
    normalized_query: str
    query_type: str


def build_retrieval_terms(raw_query: str, reviewed_synonyms: Sequence[dict[str, Any]]) -> list[str]:
    """Build a bounded recall-oriented term set without inventing synonyms."""

    normalized = normalize_query(raw_query)
    terms: list[str] = []

    def add(value: Any) -> None:
        if isinstance(value, str):
            clean = value.strip()
            if clean and clean not in terms:
                terms.append(clean)

    add(normalized.accented_normalized)
    add(normalized.accent_folded)
    for token in (*normalized.tokens, *normalized.folded_tokens):
        if len(token) >= 2:
            add(token)
    for variant in generate_fuzzy_query_variants(normalized).variants:
        add(variant.rewritten_query)

    query_fold = normalized.accented_normalized.casefold()
    for rule in reviewed_synonyms:
        source = rule.get('from')
        target = rule.get('to')
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        source_fold = source.strip().casefold()
        if source_fold and (query_fold == source_fold or source_fold in query_fold or query_fold in source_fold):
            for value in target.split(','):
                add(value)
    return terms[:24]


def rank_library_rows(
    raw_query: str,
    rows: Sequence[dict[str, Any]],
    *,
    limit: int,
    offset: int,
) -> RankedLibraryPage:
    """Rank an already-authorized candidate set, then paginate."""

    documents = tuple(_to_document(row) for row in rows)
    result = run_canonical_search(raw_query, documents, top_k=len(documents))
    row_by_id = {str(row.get('id')): row for row in rows}
    ranked_rows: list[dict[str, Any]] = []
    for ranked in result.ranked:
        source = row_by_id.get(ranked.asset_id)
        if source is None:
            continue
        row = dict(source)
        row['_search'] = {
            'rank': ranked.final_rank,
            'tier': ranked.ranking_tier.name,
            'score': round(float(ranked.combined_score), 8),
            'lexical_rank': ranked.explanation.lexical_rank,
            'semantic_rank': ranked.explanation.semantic_rank,
            'correction_used': ranked.explanation.correction_used,
        }
        ranked_rows.append(row)

    page = ranked_rows[offset : offset + limit]
    return RankedLibraryPage(
        rows=tuple(page),
        total=len(ranked_rows),
        normalized_query=result.normalized.normalized_whitespace,
        query_type=result.classification.query_type.value,
    )


def _to_document(row: dict[str, Any]) -> SearchDocument:
    keywords = row.get('keywords')
    return SearchDocument(
        asset_id=str(row.get('id') or ''),
        title=str(row.get('title') or ''),
        sku=str(row.get('sku') or ''),
        brand=str(row.get('brand') or ''),
        category=str(row.get('category') or ''),
        space=str(row.get('space') or ''),
        suggested_caption=' '.join(
            value for value in (str(row.get('suggested_caption') or ''), str(row.get('description') or '')) if value
        ),
        keywords=tuple(value for value in keywords if isinstance(value, str)) if isinstance(keywords, list) else (),
        usage_count=int(row.get('usage_count') or 0),
        created_at=str(row.get('created_at') or ''),
    )


__all__ = ['RankedLibraryPage', 'build_retrieval_terms', 'rank_library_rows']
