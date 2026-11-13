"""LTR feature-vector SCHEMA ONLY -- no training happens anywhere here.

:class:`SearchFeatureVector` is a plain, typed record of every signal a
future Learning-to-Rank model could consume. It carries NO outcome/
relevance label, is never fit against anything, and is never generated
from fabricated relevance -- see the package docstring's hard ML boundary.
Suite C human 0-3 relevance grades do not exist yet and are a hard
prerequisite before any real feature vector (with a label) could ever be
assembled from real data; this module only defines the shape.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SearchFeatureVector:
    """One (query, document) pair's full candidate feature set.

    No ``label``/``relevance``/``outcome`` field exists on this dataclass
    on purpose -- adding one would invite exactly the kind of
    fabricated-or-proxy relevance label this checkpoint must never
    produce. A future Suite C-backed training pipeline would pair a
    (separately stored, separately reviewed) real human grade with a
    vector shaped like this one; that pairing does not exist today.
    """

    query_id: str
    asset_id: str

    # Exact/entity channel (Part 2).
    exact_sku: float = 0.0
    sku_prefix: float = 0.0
    exact_model: float = 0.0
    brand_exact: float = 0.0
    brand_fuzzy: float = 0.0

    # Field-weighted lexical channel (Part 3).
    title_phrase: float = 0.0
    title_token_coverage: float = 0.0
    category_match: float = 0.0
    space_match: float = 0.0
    keyword_match: float = 0.0
    caption_match: float = 0.0
    accent_match: float = 0.0
    accent_folded_match: float = 0.0

    # Lexical similarity / fuzzy channel (Parts 4-5).
    trigram_score: float = 0.0
    edit_cost: float = 0.0
    correction_confidence: float = 0.0

    # Semantic channel (Part 6, interface only -- always 0.0/unset today
    # since no real semantic retriever is invoked in this checkpoint).
    semantic_cosine: float = 0.0
    semantic_rank: int | None = None

    # Fusion / prior ranking (Parts 7-8).
    lexical_rank: int | None = None
    rrf_score: float = 0.0

    # Query-intelligence context (Checkpoint 1).
    query_type: str = "UNKNOWN"
    entity_overlap: float = 0.0

    def as_dict(self) -> dict[str, float | int | str | None]:
        """A plain-dict view for callers that want to hand this to a
        (future, not-yet-existing) model-agnostic feature store."""

        return {
            "query_id": self.query_id,
            "asset_id": self.asset_id,
            "exact_sku": self.exact_sku,
            "sku_prefix": self.sku_prefix,
            "exact_model": self.exact_model,
            "brand_exact": self.brand_exact,
            "brand_fuzzy": self.brand_fuzzy,
            "title_phrase": self.title_phrase,
            "title_token_coverage": self.title_token_coverage,
            "category_match": self.category_match,
            "space_match": self.space_match,
            "keyword_match": self.keyword_match,
            "caption_match": self.caption_match,
            "accent_match": self.accent_match,
            "accent_folded_match": self.accent_folded_match,
            "trigram_score": self.trigram_score,
            "edit_cost": self.edit_cost,
            "correction_confidence": self.correction_confidence,
            "semantic_cosine": self.semantic_cosine,
            "semantic_rank": self.semantic_rank,
            "lexical_rank": self.lexical_rank,
            "rrf_score": self.rrf_score,
            "query_type": self.query_type,
            "entity_overlap": self.entity_overlap,
        }
