"""Unit tests for reported asset exclusion and warning formatting in MCP gateway."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from verity_dam_mcp.gateway import GatewayError, MediaMcpGateway
from verity_dam_mcp.settings import McpSettings
from verity_dam_mcp.formatting import format_media_asset, render_assets_markdown


class GatewayReportedTests(unittest.TestCase):
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

    def test_search_media_assets_default_excludes_reported_in_lexical_query(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"
        self.gateway.repository.fetch_all.return_value = [{"id": "asset-1"}]

        self.gateway.search_media_assets(["camera"], {})

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertIn("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))", sql)
        self.assertIn("has_open_report", sql)

    def test_search_media_assets_fallback_branch_excludes_reported(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"
        # First call (lexical) returns empty, second call (fallback) returns item
        self.gateway.repository.fetch_all.side_effect = [[], [{"id": "fallback-asset"}]]

        self.gateway.search_media_assets(["camera"], {})

        self.assertEqual(self.gateway.repository.fetch_all.call_count, 2)
        lexical_sql = self.gateway.repository.fetch_all.call_args_list[0][0][0]
        fallback_sql = self.gateway.repository.fetch_all.call_args_list[1][0][0]
        self.assertIn("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))", lexical_sql)
        self.assertIn("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))", fallback_sql)

    def test_search_media_assets_include_reported_forbidden_for_viewer(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.search_media_assets(["camera"], {}, include_reported=True)
        self.assertIn("reviewer or admin", str(ctx.exception))

    def test_search_media_assets_include_reported_allowed_for_reviewer(self):
        self.gateway._user_id = "user-2"
        self.gateway._role = "reviewer"
        self.gateway.repository.fetch_all.return_value = [{"id": "asset-1"}]

        self.gateway.search_media_assets(["camera"], {}, include_reported=True)

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertNotIn("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))", sql)

    def test_select_media_assets_default_excludes_reported(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"
        self.gateway.repository.fetch_all.return_value = []

        self.gateway.select("media_assets", {"review_state": "eq.approved"})

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertIn("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))", sql)
        self.assertIn("has_open_report", sql)

    def test_select_media_assets_include_reported_forbidden_for_viewer(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.select("media_assets", {"include_reported": "true"})
        self.assertIn("reviewer or admin", str(ctx.exception))

    def test_select_media_assets_include_reported_allowed_for_reviewer(self):
        self.gateway._user_id = "user-2"
        self.gateway._role = "reviewer"
        self.gateway.repository.fetch_all.return_value = []

        self.gateway.select("media_assets", {"include_reported": "true"})

        self.gateway.repository.fetch_all.assert_called_once()
        sql = self.gateway.repository.fetch_all.call_args[0][0]
        self.assertNotIn("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))", sql)

    def test_format_media_asset_and_markdown_warning(self):
        row = {
            "id": "asset-123",
            "title": "Camera Sample",
            "has_open_report": True,
            "permission": "public",
            "status": "approved",
        }
        asset = format_media_asset(row)
        self.assertTrue(asset.get("has_open_report"))

        md = render_assets_markdown([asset], "Results", "Empty")
        self.assertIn("- ⚠ REPORTED: Asset has an open issue report", md)


if __name__ == "__main__":
    unittest.main()
