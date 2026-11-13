"""Unit tests for needs_post_production exclusion and warning formatting in MCP gateway."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from verity_dam_mcp.gateway import GatewayError, MediaMcpGateway
from verity_dam_mcp.settings import McpSettings
from verity_dam_mcp.formatting import format_media_asset, render_assets_markdown


class GatewayUnfinishedTests(unittest.TestCase):
    def setUp(self):
        self.mock_settings = MagicMock(spec=McpSettings)
        self.mock_settings.database_url = "postgresql://test"
        self.mock_settings.r2_endpoint = "https://r2"
        self.mock_settings.r2_access_key_id = "key"
        self.mock_settings.r2_secret_access_key = "sec"
        self.mock_settings.r2_bucket = "bucket"
        self.mock_settings.r2_region = "auto"
        self.mock_settings.r2_public_base_url = None
        self.mock_settings.bot_user_id = "11111111-1111-1111-1111-111111111111"

        with patch("verity_dam_mcp.gateway.PostgresRepository"), patch("verity_dam_mcp.gateway.R2Storage"):
            self.gateway = MediaMcpGateway(self.mock_settings)
            self.gateway.repository = MagicMock()

    def test_search_media_assets_default_excludes_unfinished_in_lexical_query(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"
        self.gateway.repository.fetch_all.return_value = [{"id": "asset-1"}]

        self.gateway.search_media_assets(["camera"], {})

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertIn("not a.needs_post_production", sql)

    def test_search_media_assets_fallback_branch_excludes_unfinished(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"
        self.gateway.repository.fetch_all.side_effect = [[], [{"id": "fallback-asset"}]]

        self.gateway.search_media_assets(["camera"], {})

        self.assertEqual(self.gateway.repository.fetch_all.call_count, 2)
        lexical_sql = self.gateway.repository.fetch_all.call_args_list[0][0][0]
        fallback_sql = self.gateway.repository.fetch_all.call_args_list[1][0][0]
        self.assertIn("not a.needs_post_production", lexical_sql)
        self.assertIn("not a.needs_post_production", fallback_sql)

    def test_search_media_assets_include_unfinished_forbidden_for_viewer(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.search_media_assets(["camera"], {}, include_unfinished=True)
        self.assertIn("reviewer or admin", str(ctx.exception))

    def test_search_media_assets_include_unfinished_allowed_for_reviewer(self):
        self.gateway._user_id = "user-2"
        self.gateway._role = "reviewer"
        self.gateway.repository.fetch_all.return_value = [{"id": "asset-1"}]

        self.gateway.search_media_assets(["camera"], {}, include_unfinished=True)

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertNotIn("not a.needs_post_production", sql)

    def test_select_media_assets_default_excludes_unfinished(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"
        self.gateway.repository.fetch_all.return_value = []

        self.gateway.select("media_assets", {"review_state": "eq.approved"})

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertIn("not a.needs_post_production", sql)

    def test_select_media_assets_include_unfinished_forbidden_for_viewer(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.select("media_assets", {"include_unfinished": "true"})
        self.assertIn("reviewer or admin", str(ctx.exception))

    def test_select_media_assets_include_unfinished_allowed_for_reviewer(self):
        self.gateway._user_id = "user-2"
        self.gateway._role = "reviewer"
        self.gateway.repository.fetch_all.return_value = []

        self.gateway.select("media_assets", {"include_unfinished": "true"})

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertNotIn("not a.needs_post_production", sql)

    def test_format_media_asset_and_markdown_warning(self):
        row = {
            "id": "asset-123",
            "title": "Raw Sample",
            "needs_post_production": True,
            "permission": "public",
            "status": "approved",
        }
        asset = format_media_asset(row)
        self.assertTrue(asset.get("needs_post_production"))

        md = render_assets_markdown([asset], "Results", "Empty")
        self.assertIn("needs post-production", md)


if __name__ == "__main__":
    unittest.main()
