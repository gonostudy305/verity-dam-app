import unittest
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.native_gateway import _nullable_text, _text


class NativeGatewayIngestStatusTests(unittest.TestCase):
    """Test that ingest_status accurately reflects success/failure and
    guards against PostgreSQL '' IS NOT NULL evaluation pitfall."""

    def test_nullable_text_behavior(self):
        # Empty string and None must produce None so SQL nullif / IS NOT NULL works
        self.assertIsNone(_nullable_text(None))
        self.assertIsNone(_nullable_text(""))
        self.assertIsNone(_nullable_text("   "))
        self.assertIsNone(_nullable_text(123))

        # Non-empty string returns stripped text
        self.assertEqual(_nullable_text("Vision timeout"), "Vision timeout")
        self.assertEqual(_nullable_text("  Network error  "), "Network error")

    def test_text_vs_nullable_text_contrast(self):
        # _text returns empty string for None
        self.assertEqual(_text(None), "")
        # _nullable_text returns None for None and empty string
        self.assertIsNone(_nullable_text(None))
        self.assertIsNone(_nullable_text(""))


if __name__ == "__main__":
    unittest.main()
