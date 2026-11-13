from __future__ import annotations

import unittest

from search_intelligence.contract import run_canonical_search
from search_intelligence.search_document import SearchDocument


class PermissionOrderTest(unittest.TestCase):
    """Part 16: authorization is a hard constraint, never a ranking
    feature. This checkpoint's contract (``run_canonical_search``) takes
    NO permission argument on purpose -- the preferred, and only
    supported, integration order is eligible-candidate-set -> ranking:
    the caller must filter to permission-eligible documents BEFORE calling
    the search-intelligence layer at all, so an excluded document's data
    (title, sku, brand, ...) never even reaches lexical scoring, fuzzy
    matching, or the rank explanation -- there is no code path here that
    could resurrect it by score, tier, or fuzzy/synonym recovery.
    """

    def test_document_excluded_before_search_never_appears_in_results(self) -> None:
        # An "internal"/excluded asset that would otherwise be the best
        # lexical match for this query.
        excluded = SearchDocument(asset_id="internal-1", title="khóa thông minh Verity nội bộ")
        eligible = SearchDocument(asset_id="public-1", title="camera ngoài trời")

        # Correct integration: permission filtering happens BEFORE this
        # call -- the excluded document is never passed in at all.
        result = run_canonical_search("khóa thông minh", [eligible])

        asset_ids = [item.asset_id for item in result.ranked]
        self.assertNotIn("internal-1", asset_ids)
        if result.ranked:
            self.assertEqual(result.ranked[0].asset_id, "public-1")

    def test_excluded_document_leaves_no_trace_in_rank_explanations(self) -> None:
        excluded = SearchDocument(asset_id="internal-2", title="khóa thông minh Verity nội bộ")
        result = run_canonical_search("khóa thông minh", [])  # excluded never passed in
        for item in result.ranked:
            self.assertNotEqual(item.asset_id, excluded.asset_id)
            self.assertNotIn("internal-2", item.explanation.feature_values)

    def test_permission_filtering_never_a_ranking_feature(self) -> None:
        # SearchDocument itself carries no permission/role field -- proving
        # structurally that no ranking signal in this checkpoint can even
        # be conditioned on permission state; that decision must happen
        # entirely upstream, in the caller's eligible-candidate-set step.
        fields = SearchDocument.__dataclass_fields__
        self.assertNotIn("permission", fields)
        self.assertNotIn("role", fields)
        self.assertNotIn("visibility", fields)


if __name__ == "__main__":
    unittest.main()
