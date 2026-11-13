from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.image_processing import compose_canonical_title, is_generic_or_raw_title


class ImageProcessingTitleTests(unittest.TestCase):
    def test_numeric_upload_titles_are_generic(self) -> None:
        self.assertTrue(is_generic_or_raw_title("16"))
        self.assertTrue(is_generic_or_raw_title("001"))

    def test_numeric_title_composes_from_reviewed_metadata(self) -> None:
        self.assertEqual(
            compose_canonical_title({
                "title": "16",
                "brand": "EDEN",
                "sku": "CS-CB90f/SP-R100(5MP+5MP+5MP)",
                "space": "Ngoài trời / Cổng",
            }),
            "EDEN CS-CB90f/SP-R100(5MP+5MP+5MP) - Ngoài trời / Cổng",
        )


if __name__ == "__main__":
    unittest.main()
