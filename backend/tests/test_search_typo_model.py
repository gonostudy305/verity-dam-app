from __future__ import annotations

import unittest

from search_intelligence.typo_model import (
    correct_token,
    generate_query_candidates,
    weighted_edit_distance,
)
from search_intelligence.vietnamese_normalizer import normalize_query


def _corrected_values(token: str) -> list[str]:
    return [candidate.corrected_token for candidate in correct_token(token)]


class AccentAndToneTest(unittest.TestCase):
    def test_missing_accent_khoa_corrects_to_khoa_with_accent(self) -> None:
        candidates = correct_token("khoa")
        self.assertIn("khóa", _corrected_values("khoa"))
        top = next(c for c in candidates if c.corrected_token == "khóa")
        self.assertEqual(top.edit_type, "accent_or_tone")

    def test_missing_accent_thong_corrects_to_thong_with_accent(self) -> None:
        self.assertIn("thông", _corrected_values("thong"))

    def test_wrong_tone_mark_bien_vs_bien_sac(self) -> None:
        # "biên" (flat ê) is the wrong tone for the real word "biến" (acute).
        candidates = correct_token("biên")
        values = _corrected_values("biên")
        self.assertIn("biến", values)
        top = next(c for c in candidates if c.corrected_token == "biến")
        self.assertEqual(top.edit_type, "accent_or_tone")

    def test_already_correct_word_needs_no_correction(self) -> None:
        self.assertEqual(correct_token("khóa"), ())
        self.assertEqual(correct_token("minh"), ())


class TranspositionTest(unittest.TestCase):
    def test_thogn_transposition_corrects_to_thong(self) -> None:
        self.assertIn("thông", _corrected_values("thôgn"))

    def test_khao_transposition_plus_accent_corrects_to_khoa(self) -> None:
        self.assertIn("khóa", _corrected_values("khao"))

    def test_amce_transposition_corrects_to_acme_brand(self) -> None:
        values = [value.casefold() for value in _corrected_values("amce")]
        self.assertIn("acme", values)


class TelexResidueTest(unittest.TestCase):
    def test_trailing_s_residue_is_recognized_low_cost(self) -> None:
        candidates = correct_token("khoas")
        values = [c.corrected_token for c in candidates]
        self.assertIn("khóa", values)
        top = next(c for c in candidates if c.corrected_token == "khóa")
        self.assertEqual(top.edit_type, "telex_residue")

    def test_trailing_f_residue_recognized(self) -> None:
        candidates = correct_token("thongf")
        values = [c.corrected_token for c in candidates]
        self.assertIn("thông", values)


class VniResidueTest(unittest.TestCase):
    def test_trailing_digit_residue_is_recognized_low_cost(self) -> None:
        candidates = correct_token("khoa1")
        values = [c.corrected_token for c in candidates]
        self.assertIn("khóa", values)
        top = next(c for c in candidates if c.corrected_token == "khóa")
        self.assertEqual(top.edit_type, "vni_residue")


class BrandTypoTest(unittest.TestCase):
    def test_driit_corrects_to_drift(self) -> None:
        values = [value.casefold() for value in _corrected_values("driit")]
        self.assertIn("drift", values)

    def test_robork_corrects_to_rover(self) -> None:
        values = [value.casefold() for value in _corrected_values("robork")]
        self.assertIn("rover", values)


class ExactSkuGuardInTypoModelTest(unittest.TestCase):
    def test_real_sku_token_is_never_corrected(self) -> None:
        self.assertEqual(correct_token("HR-21"), ())

    def test_real_sku_token_case_insensitive_is_never_corrected(self) -> None:
        self.assertEqual(correct_token("hr-21"), ())

    def test_full_query_with_sku_never_corrects_the_sku_token(self) -> None:
        normalized = normalize_query("khoa HR-21 Verity")
        result = generate_query_candidates(normalized)
        sku_token_candidates = dict(result.per_token)["hr-21"]
        self.assertEqual(sku_token_candidates, ())


class MultiTokenSkuGuardTest(unittest.TestCase):
    """Part 0B fix: a multi-token exact SKU/model span (no single token of
    which is itself a complete SKU code) must protect EVERY token inside
    that span from typo correction, not just a token that alone matches."""

    def test_q10_vf_tokens_are_never_corrected(self) -> None:
        normalized = normalize_query("rover Q10 VF")
        result = generate_query_candidates(normalized)
        by_token = dict(result.per_token)
        self.assertEqual(by_token["q10"], ())
        self.assertEqual(by_token["vf"], ())

    def test_single_token_sku_still_protected_via_protected_indexes(self) -> None:
        normalized = normalize_query("khoa HR-21 Verity")
        result = generate_query_candidates(normalized)
        self.assertIn(normalized.tokens.index("hr-21"), result.protected_token_indexes)

    def test_no_protected_indexes_when_no_sku_present(self) -> None:
        normalized = normalize_query("khoa thong minh")
        result = generate_query_candidates(normalized)
        self.assertEqual(result.protected_token_indexes, ())


class MixedVietnameseEnglishAndRealisticExamplesTest(unittest.TestCase):
    def test_cam_bien_cua_all_tokens_correct(self) -> None:
        normalized = normalize_query("cam bien cua")
        result = generate_query_candidates(normalized)
        by_token = dict(result.per_token)
        self.assertIn("cảm", [c.corrected_token for c in by_token["cam"]])
        self.assertIn("biến", [c.corrected_token for c in by_token["bien"]])
        self.assertIn("cửa", [c.corrected_token for c in by_token["cua"]])

    def test_cam_bien_cua_wrong_tone_variant(self) -> None:
        normalized = normalize_query("cảm biên cửa")
        result = generate_query_candidates(normalized)
        by_token = dict(result.per_token)
        self.assertIn("biến", [c.corrected_token for c in by_token["biên"]])

    def test_robot_hut_bui_corrects_diacritics(self) -> None:
        normalized = normalize_query("robot hut bùi")
        result = generate_query_candidates(normalized)
        by_token = dict(result.per_token)
        self.assertIn("hút", [c.corrected_token for c in by_token["hut"]])
        self.assertIn("bụi", [c.corrected_token for c in by_token["bùi"]])
        # "robot" is already correct -- no correction needed.
        self.assertEqual(by_token["robot"], ())

    def test_search_original_flag_always_true(self) -> None:
        normalized = normalize_query("khoa thong minh")
        result = generate_query_candidates(normalized)
        self.assertTrue(result.search_original)


class ExplanationCompletenessTest(unittest.TestCase):
    def test_every_candidate_exposes_full_explanation(self) -> None:
        for candidate in correct_token("khoa"):
            self.assertTrue(candidate.edit_type)
            self.assertGreaterEqual(candidate.cost, 0.0)
            self.assertTrue(candidate.vocabulary_source)
            self.assertTrue(0.0 <= candidate.confidence <= 1.0)


class WeightedEditDistanceUnitTest(unittest.TestCase):
    def test_identical_strings_zero_distance(self) -> None:
        self.assertEqual(weighted_edit_distance("khoa", "khoa"), 0.0)

    def test_accent_only_difference_is_cheap(self) -> None:
        self.assertLess(weighted_edit_distance("khoa", "khóa"), 1.0)

    def test_completely_different_words_cost_more_than_accent_diff(self) -> None:
        self.assertGreater(weighted_edit_distance("xyz", "khoa"), weighted_edit_distance("khoa", "khóa"))


if __name__ == "__main__":
    unittest.main()
