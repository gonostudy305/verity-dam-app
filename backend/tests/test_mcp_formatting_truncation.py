"""Unit tests for the item-boundary-aware truncation fix in formatting.py.

Prior bug: render_json() did a raw text[:25_000] slice on an already-serialized
JSON string, corrupting the JSON whenever the payload exceeded the character
limit (reliably reproducible with media_list_library at limit>=~10 rows).
This suite pins that render_json/render_assets_markdown always emit valid,
in-limit output regardless of payload size, and that the unrelated legacy
_truncate() path (still used by media_search's optional markdown_summary)
is unaffected.
"""

from __future__ import annotations

import json
import unittest

from verity_dam_mcp.formatting import (
    CHARACTER_LIMIT,
    _truncate,
    render_assets_markdown,
    render_json,
)


def _make_asset(i: int) -> dict:
    return {
        "id": f"asset-{i:04d}",
        "title": f"Sample Product Photo {i}",
        "file_url": f"https://assets.verity.internal/wp-content/uploads/2026/09/sample-{i}.webp",
        "thumbnail_url": f"https://assets.verity.internal/wp-content/uploads/2026/09/thumb-{i}.webp",
        "sku": f"SKU-{i:04d}",
        "brand": "EDEN",
        "category": "camera",
        "space": "living_room",
        "status": "approved",
        "permission": "public",
        "review_state": "approved",
        "description": "A reasonably long description to inflate payload size " * 3,
        "keywords": ["camera", "security", "homeware"],
    }


class RenderJsonTruncationTests(unittest.TestCase):
    def test_small_list_payload_returned_unchanged(self):
        payload = [_make_asset(i) for i in range(3)]
        text = render_json(payload)
        self.assertEqual(json.loads(text), payload)

    def test_large_list_payload_truncates_to_valid_json(self):
        payload = [_make_asset(i) for i in range(2000)]
        text = render_json(payload)

        self.assertLessEqual(len(text), CHARACTER_LIMIT)
        parsed = json.loads(text)  # must not raise -- this was the corrupting bug
        self.assertTrue(parsed["truncated"])
        self.assertEqual(parsed["returned_count"], len(parsed["results"]))
        self.assertEqual(parsed["total_candidate_count"], len(payload))
        self.assertLess(parsed["returned_count"], len(payload))
        # Every returned item must be a full, untruncated original item (item-boundary safe)
        for item in parsed["results"]:
            self.assertIn(item["id"], {a["id"] for a in payload})

    def test_non_list_payload_over_limit_returns_valid_note_json(self):
        huge_dict = {"description": "x" * (CHARACTER_LIMIT + 1000)}
        text = render_json(huge_dict)
        parsed = json.loads(text)  # must not raise
        self.assertTrue(parsed["truncated"])
        self.assertLessEqual(len(text), CHARACTER_LIMIT + 200)

    def test_non_list_payload_under_limit_returned_unchanged(self):
        payload = {"id": "asset-1", "title": "ok"}
        text = render_json(payload)
        self.assertEqual(json.loads(text), payload)


class RenderAssetsMarkdownTruncationTests(unittest.TestCase):
    def test_small_markdown_payload_includes_all_assets(self):
        assets = [_make_asset(i) for i in range(3)]
        md = render_assets_markdown(assets, "Results", "No results")
        for asset in assets:
            self.assertIn(asset["id"], md)

    def test_large_markdown_payload_truncates_at_item_boundary(self):
        assets = [_make_asset(i) for i in range(2000)]
        md = render_assets_markdown(assets, "Results", "No results")

        self.assertLessEqual(len(md), CHARACTER_LIMIT)
        self.assertIn("truncated after", md)
        # No item should appear "cut in half" -- every asset-id line present is
        # for an asset whose full block was included.
        included_ids = [a["id"] for a in assets if a["id"] in md]
        self.assertLess(len(included_ids), len(assets))
        for asset_id in included_ids:
            self.assertIn(f"`{asset_id}`", md)

    def test_empty_assets_list_returns_empty_message(self):
        md = render_assets_markdown([], "Results", "Nothing here")
        self.assertIn("Nothing here", md)


class LegacyTruncateUnaffectedTests(unittest.TestCase):
    """media_search's optional markdown_summary field still goes through the
    legacy plain-text _truncate(); this must remain unchanged."""

    def test_short_text_returned_unchanged(self):
        self.assertEqual(_truncate("hello"), "hello")

    def test_long_text_still_uses_plain_slice_suffix(self):
        text = "y" * (CHARACTER_LIMIT + 500)
        result = _truncate(text)
        self.assertTrue(result.startswith("y" * 100))
        self.assertIn("truncated at", result)


if __name__ == "__main__":
    unittest.main()
