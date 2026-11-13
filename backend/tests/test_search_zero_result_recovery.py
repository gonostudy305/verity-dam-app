from __future__ import annotations

import unittest

from search_intelligence.vietnamese_normalizer import normalize_query
from search_intelligence.zero_result_recovery import RecoveryStage, recover_zero_result


class ZeroResultRecoveryOrderTest(unittest.TestCase):
    def test_stops_at_first_stage_with_original_lexical(self) -> None:
        normalized = normalize_query("khóa thông minh")
        result = recover_zero_result(
            normalized,
            accented_lexical_fn=lambda n: ("d1",),
            folded_lexical_fn=lambda n: ("should", "not", "be", "reached"),
            fuzzy_fn=lambda n: (),
            synonym_fn=lambda n: (),
        )
        self.assertEqual(result.recovery_stage_used, RecoveryStage.ORIGINAL_ACCENTED_LEXICAL)
        self.assertEqual(result.candidate_asset_ids, ("d1",))
        self.assertEqual(result.attempted_stages, (RecoveryStage.ORIGINAL_ACCENTED_LEXICAL,))

    def test_falls_through_to_folded_lexical(self) -> None:
        normalized = normalize_query("khoa thong minh")
        result = recover_zero_result(
            normalized,
            accented_lexical_fn=lambda n: (),
            folded_lexical_fn=lambda n: ("d2",),
            fuzzy_fn=lambda n: (),
            synonym_fn=lambda n: (),
        )
        self.assertEqual(result.recovery_stage_used, RecoveryStage.ACCENT_FOLDED_LEXICAL)

    def test_falls_through_to_fuzzy_then_synonyms_in_order(self) -> None:
        normalized = normalize_query("khoa")
        called = []

        def fuzzy_fn(n):
            called.append("fuzzy")
            return ()

        def synonym_fn(n):
            called.append("synonyms")
            return ("d3",)

        result = recover_zero_result(
            normalized,
            accented_lexical_fn=lambda n: (),
            folded_lexical_fn=lambda n: (),
            fuzzy_fn=fuzzy_fn,
            synonym_fn=synonym_fn,
        )
        self.assertEqual(result.recovery_stage_used, RecoveryStage.REVIEWED_SYNONYMS)
        self.assertEqual(called, ["fuzzy", "synonyms"])

    def test_optional_semantic_stage_only_tried_when_supplied(self) -> None:
        normalized = normalize_query("khoa")
        result = recover_zero_result(
            normalized,
            accented_lexical_fn=lambda n: (),
            folded_lexical_fn=lambda n: (),
            fuzzy_fn=lambda n: (),
            synonym_fn=lambda n: (),
            semantic_fn=lambda n: ("d4",),
        )
        self.assertEqual(result.recovery_stage_used, RecoveryStage.FUTURE_SEMANTIC_CHANNEL)

    def test_exhausted_when_no_stage_produces_results(self) -> None:
        normalized = normalize_query("khoa")
        result = recover_zero_result(
            normalized,
            accented_lexical_fn=lambda n: (),
            folded_lexical_fn=lambda n: (),
            fuzzy_fn=lambda n: (),
            synonym_fn=lambda n: (),
        )
        self.assertEqual(result.recovery_stage_used, RecoveryStage.EXHAUSTED)
        self.assertEqual(result.candidate_asset_ids, ())
        self.assertEqual(len(result.attempted_stages), 4)

    def test_original_query_object_is_never_mutated(self) -> None:
        normalized = normalize_query("khóa thông minh")
        before = normalized
        recover_zero_result(
            normalized,
            accented_lexical_fn=lambda n: (),
            folded_lexical_fn=lambda n: (),
            fuzzy_fn=lambda n: (),
            synonym_fn=lambda n: (),
        )
        # frozen dataclass -- identity and equality both must be unchanged
        self.assertIs(normalized, before)
        self.assertEqual(normalized.raw_query, "khóa thông minh")


if __name__ == "__main__":
    unittest.main()
