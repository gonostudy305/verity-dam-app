from __future__ import annotations

import unittest

from search_intelligence.suite_c_schema import (
    HUMAN_SUITE_C_LABELS_AVAILABLE,
    SuiteCRow,
    assert_no_suite_c_labels_exist,
)


class SuiteCBridgeTest(unittest.TestCase):
    def test_no_labels_available_flag_is_false(self) -> None:
        self.assertFalse(HUMAN_SUITE_C_LABELS_AVAILABLE)

    def test_assert_helper_does_not_raise_today(self) -> None:
        assert_no_suite_c_labels_exist()  # must not raise

    def test_schema_validates_grade_range(self) -> None:
        with self.assertRaises(ValueError):
            SuiteCRow(
                query_id="q1",
                intent_group_id="g1",
                query_text="khóa thông minh",
                grade=4,
                asset_id="a1",
                reviewer_id="r1",
                reviewed_at="2026-01-01T00:00:00Z",
            )

    def test_valid_row_carries_intent_group_id_for_grouped_split(self) -> None:
        row = SuiteCRow(
            query_id="q_accented",
            intent_group_id="intent-smart-lock-1",
            query_text="khóa thông minh",
            grade=3,
            asset_id="a1",
            reviewer_id="r1",
            reviewed_at="2026-01-01T00:00:00Z",
        )
        sibling = SuiteCRow(
            query_id="q_unaccented",
            intent_group_id="intent-smart-lock-1",
            query_text="khoa thong minh",
            grade=3,
            asset_id="a1",
            reviewer_id="r1",
            reviewed_at="2026-01-01T00:00:00Z",
        )
        self.assertEqual(row.intent_group_id, sibling.intent_group_id)


if __name__ == "__main__":
    unittest.main()
