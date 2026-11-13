from __future__ import annotations

import unittest

from search_intelligence.contract import SearchIntelligenceContract, run_canonical_search
from search_intelligence.search_document import SearchDocument
from search_intelligence.semantic_adapter import SemanticAdapterError, SemanticHit


class CanonicalEngineAdapter:
    """Wraps :func:`run_canonical_search` to literally satisfy
    :class:`SearchIntelligenceContract`'s ``search(raw_query, documents,
    *, top_k)`` shape -- proving the contract Protocol is satisfiable."""

    def search(self, raw_query: str, documents, *, top_k: int = 20):
        return run_canonical_search(raw_query, documents, top_k=top_k).ranked


class SearchIntelligenceContractTest(unittest.TestCase):
    def test_canonical_engine_satisfies_the_contract_protocol(self) -> None:
        engine: SearchIntelligenceContract = CanonicalEngineAdapter()
        documents = [SearchDocument(asset_id="a1", sku="HR-21", title="Khoa Verity")]
        results = engine.search("HR-21", documents, top_k=5)
        self.assertEqual(results[0].asset_id, "a1")


class ParityFixtureTest(unittest.TestCase):
    """Each fixture documents how the CANONICAL engine ranks a small
    input, and (in the comment) how that already diverges from what the
    three existing production paths do today per the BASELINE_L0 census
    (docs/search/VIETNAMESE_SEARCH_ARCHITECTURE.md) -- none of the three
    existing paths is rewritten by this checkpoint."""

    def test_exact_sku_beats_high_usage_count_keyword_match(self) -> None:
        # DIVERGENCE FROM PATH A (production ILIKE): path A sorts strictly
        # by usage_count/created_at -- a text match never affects order at
        # all, so a frequently-used, merely-keyword-matching document could
        # rank ABOVE a fresh, exact-SKU document today. The canonical
        # engine's Tier 0 (exact SKU) always outranks a Tier 4 (relevance
        # only) document, regardless of usage_count.
        exact_sku_doc = SearchDocument(asset_id="fresh-exact", sku="HR-21", title="Khoa Verity", usage_count=0)
        high_usage_keyword_doc = SearchDocument(
            asset_id="popular-keyword", title="khóa Verity cửa chính rất phổ biến", usage_count=9999
        )
        result = run_canonical_search("HR-21", [high_usage_keyword_doc, exact_sku_doc])
        self.assertEqual(result.ranked[0].asset_id, "fresh-exact")

    def test_accented_and_unaccented_query_rank_the_same_document_top(self) -> None:
        # DIVERGENCE FROM PATH C (demo .includes(), no accent folding):
        # path C's plain substring match on an unaccented query would miss
        # an accented-only title entirely. The canonical engine's
        # accent-folded lexical feature still matches it either way.
        document = SearchDocument(asset_id="a1", title="khóa cửa thông minh")
        accented = run_canonical_search("khóa cửa thông minh", [document])
        unaccented = run_canonical_search("khoa cua thong minh", [document])
        self.assertEqual(accented.ranked[0].asset_id, "a1")
        self.assertEqual(unaccented.ranked[0].asset_id, "a1")

    def test_brand_typo_still_surfaces_the_brand_document_via_fuzzy_channel(self) -> None:
        # DIVERGENCE FROM PATH B (MCP ILIKE, no synonym/typo expansion at
        # all): "aqraa" (transposed) would return zero results on path B.
        # The canonical engine's fuzzy channel recognizes the correction
        # and the reranker's entity_overlap/lexical signals still surface
        # the real Acme document as the top (only) result.
        document = SearchDocument(asset_id="a1", title="Camera Acme G3", brand="Acme")
        result = run_canonical_search("aqraa camera", [document])
        self.assertEqual(result.ranked[0].asset_id, "a1")


class ZeroEvidenceFilterTest(unittest.TestCase):
    """Gap B regression (PR #31 review 5109220215): a document with no
    positive retrieval signal at all must never enter final ranking
    merely because it was in the caller's eligible candidate set."""

    def test_zero_evidence_document_is_excluded_from_ranking(self) -> None:
        zero_evidence_doc = SearchDocument(asset_id="ghost", title="hoàn toàn không liên quan gì cả")
        matching_doc = SearchDocument(asset_id="match", sku="HR-21", title="Khóa Verity")
        result = run_canonical_search("HR-21", [zero_evidence_doc, matching_doc])
        ranked_ids = [item.asset_id for item in result.ranked]
        self.assertIn("match", ranked_ids)
        self.assertNotIn("ghost", ranked_ids)

    def test_controlled_nonsense_query_against_broad_candidate_set_returns_empty(self) -> None:
        documents = [
            SearchDocument(asset_id=f"doc-{i}", title=f"Sản phẩm mẫu số {i}", brand="Verity", category="Khóa")
            for i in range(25)
        ]
        result = run_canonical_search("xyzzy-no-such-product-999", documents)
        self.assertEqual(result.ranked, ())

    def test_a_document_with_only_positive_fuzzy_evidence_still_ranks(self) -> None:
        document = SearchDocument(asset_id="a1", title="Camera Acme G3", brand="Acme")
        result = run_canonical_search("aqraa camera", [document])
        self.assertEqual(len(result.ranked), 1)
        self.assertEqual(result.ranked[0].asset_id, "a1")


class SemanticHitValidationTest(unittest.TestCase):
    """Part 3 / Gap-adjacent regression: run_canonical_search must never
    directly trust a SemanticRetriever's raw output -- every hit must be
    routed through validate_semantic_hits() before it can affect fusion."""

    class _MisbehavingRetriever:
        def retrieve(self, normalized, top_k):
            return (SemanticHit(asset_id="a1", semantic_score=float("nan"), semantic_rank=1, space_id="verity-siglip2-b32-256-webli-v1"),)

    def test_invalid_semantic_hit_raises_instead_of_silently_fusing(self) -> None:
        document = SearchDocument(asset_id="a1", sku="HR-21", title="Khóa Verity")
        with self.assertRaises(SemanticAdapterError):
            run_canonical_search("HR-21", [document], semantic_retriever=self._MisbehavingRetriever())


if __name__ == "__main__":
    unittest.main()
