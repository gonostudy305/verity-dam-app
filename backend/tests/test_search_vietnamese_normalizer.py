from __future__ import annotations

import unicodedata
import unittest

from search_intelligence.vietnamese_normalizer import normalize_query, strip_diacritics, tokenize


class NfcNfdEquivalenceTest(unittest.TestCase):
    def test_nfc_and_nfd_input_produce_identical_downstream_fields(self) -> None:
        nfc_input = "khóa cửa"  # precomposed
        nfd_input = unicodedata.normalize("NFD", nfc_input)  # decomposed
        self.assertNotEqual(nfc_input, nfd_input)  # sanity: genuinely different codepoints

        nfc_result = normalize_query(nfc_input)
        nfd_result = normalize_query(nfd_input)

        self.assertEqual(nfc_result.unicode_nfc, nfd_result.unicode_nfc)
        self.assertEqual(nfc_result.accented_normalized, nfd_result.accented_normalized)
        self.assertEqual(nfc_result.accent_folded, nfd_result.accent_folded)
        self.assertEqual(nfc_result.tokens, nfd_result.tokens)

    def test_original_raw_query_is_never_destroyed(self) -> None:
        raw = "  Khóa THÔNG minh  "
        result = normalize_query(raw)
        self.assertEqual(result.raw_query, raw)


class AccentedFormsTest(unittest.TestCase):
    def test_accented_normalized_preserves_diacritics(self) -> None:
        result = normalize_query("Khóa cửa thông minh")
        self.assertIn("khóa", result.accented_normalized)
        self.assertIn("cửa", result.accented_normalized)
        self.assertIn("thông", result.accented_normalized)

    def test_both_accented_and_folded_forms_remain_available(self) -> None:
        result = normalize_query("Cảm biến cửa")
        self.assertEqual(result.accented_normalized, "cảm biến cửa")
        self.assertEqual(result.accent_folded, "cam bien cua")
        # neither is empty / neither replaces the other
        self.assertTrue(result.accented_normalized)
        self.assertTrue(result.accent_folded)
        self.assertNotEqual(result.accented_normalized, result.accent_folded)


class AccentFoldingCorrectnessTest(unittest.TestCase):
    def test_strip_diacritics_handles_all_vietnamese_tone_marks(self) -> None:
        cases = {
            "á": "a", "à": "a", "ả": "a", "ã": "a", "ạ": "a",
            "ă": "a", "ắ": "a", "ằ": "a", "ẳ": "a", "ẵ": "a", "ặ": "a",
            "â": "a", "ấ": "a", "ầ": "a", "ẩ": "a", "ẫ": "a", "ậ": "a",
            "ê": "e", "ế": "e", "ề": "e", "ể": "e", "ễ": "e", "ệ": "e",
            "ô": "o", "ố": "o", "ồ": "o", "ổ": "o", "ỗ": "o", "ộ": "o",
            "ơ": "o", "ớ": "o", "ờ": "o", "ở": "o", "ỡ": "o", "ợ": "o",
            "ư": "u", "ứ": "u", "ừ": "u", "ử": "u", "ữ": "u", "ự": "u",
            "đ": "d", "Đ": "D",
        }
        for accented, expected_base in cases.items():
            with self.subTest(accented=accented):
                self.assertEqual(strip_diacritics(accented), expected_base)

    def test_fold_of_already_ascii_text_is_unchanged(self) -> None:
        self.assertEqual(strip_diacritics("acme hub m2"), "acme hub m2")

    def test_full_query_fold_matches_expected_ascii(self) -> None:
        result = normalize_query("Khóa Thông Minh Acme M100 Zigbee")
        self.assertEqual(result.accent_folded, "khoa thong minh acme m100 zigbee")


class TokenizationTest(unittest.TestCase):
    def test_empty_query_yields_empty_tokens(self) -> None:
        result = normalize_query("")
        self.assertEqual(result.tokens, ())
        self.assertEqual(result.folded_tokens, ())
        self.assertEqual(result.accented_normalized, "")
        self.assertEqual(result.accent_folded, "")

    def test_none_query_is_treated_as_empty(self) -> None:
        result = normalize_query(None)  # type: ignore[arg-type]
        self.assertEqual(result.raw_query, "")
        self.assertEqual(result.tokens, ())

    def test_punctuation_only_query_yields_empty_tokens(self) -> None:
        result = normalize_query("???---!!!")
        self.assertEqual(result.tokens, ())

    def test_punctuation_heavy_query_still_extracts_word_tokens(self) -> None:
        result = normalize_query("khóa!!, cửa??")
        self.assertEqual(result.tokens, ("khóa", "cửa"))

    def test_multiple_and_irregular_whitespace_collapses(self) -> None:
        result = normalize_query("khóa   \t cửa\n\nchính")
        self.assertEqual(result.normalized_whitespace, "khóa cửa chính")
        self.assertEqual(result.tokens, ("khóa", "cửa", "chính"))

    def test_tokenize_helper_matches_normalize_query_tokens(self) -> None:
        text = "robot hút bụi"
        self.assertEqual(tokenize(text), ("robot", "hút", "bụi"))


if __name__ == "__main__":
    unittest.main()
