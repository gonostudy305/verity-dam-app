"""Unit tests for the publish-time safety guard in MediaMcpGateway.record_usage.

Covers the guard matrix from the MCP publish safety guard plan (Phase 03):
- phantom/non-approved asset -> fail closed
- open issue report -> unconditional block, allow_unfinished cannot override it
- needs_post_production -> blocked unless allow_unfinished=true from reviewer/admin
- role gating on both the base call and the allow_unfinished override
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from verity_dam_mcp.gateway import GatewayError, MediaMcpGateway
from verity_dam_mcp.settings import McpSettings

_ASSET_ID = "43a5a39e-7567-4103-a1ba-c602d76e361b"


class GatewayRecordUsageGuardTests(unittest.TestCase):
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

    def _mock_insert(self, usage_id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", used_at="2026-09-23T09:00:00+00:00"):
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (usage_id, used_at)
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_cursor
        mock_ctx.__exit__.return_value = None
        self.gateway.repository.transaction.return_value = mock_ctx
        return mock_cursor

    def test_viewer_role_forbidden(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "viewer"

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.record_usage(_ASSET_ID, "facebook")
        self.assertIn("not allowed", str(ctx.exception))

    def test_phantom_asset_fails_closed(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "contributor"
        self.gateway.repository.fetch_one.return_value = None

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.record_usage(_ASSET_ID, "facebook")
        self.assertIn("not found, deleted, or not yet approved", str(ctx.exception))

    def test_open_report_blocks_unconditionally(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "reviewer"
        self.gateway.repository.fetch_one.return_value = {
            "id": _ASSET_ID, "needs_post_production": False, "has_open_report": True,
        }

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.record_usage(_ASSET_ID, "facebook", allow_unfinished=True)
        self.assertIn("open issue report", str(ctx.exception))

    def test_needs_post_production_blocked_without_override(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "contributor"
        self.gateway.repository.fetch_one.return_value = {
            "id": _ASSET_ID, "needs_post_production": True, "has_open_report": False,
        }

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.record_usage(_ASSET_ID, "facebook")
        self.assertIn("needs_post_production", str(ctx.exception))

    def test_needs_post_production_override_forbidden_for_contributor(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "contributor"
        self.gateway.repository.fetch_one.return_value = {
            "id": _ASSET_ID, "needs_post_production": True, "has_open_report": False,
        }

        with self.assertRaises(GatewayError) as ctx:
            self.gateway.record_usage(_ASSET_ID, "crm", allow_unfinished=True)
        self.assertIn("not allowed", str(ctx.exception))

    def test_needs_post_production_override_allowed_for_reviewer(self):
        self.gateway._user_id = "user-2"
        self.gateway._role = "reviewer"
        self.gateway.repository.fetch_one.return_value = {
            "id": _ASSET_ID, "needs_post_production": True, "has_open_report": False,
        }
        self._mock_insert()

        result = self.gateway.record_usage(_ASSET_ID, "crm", allow_unfinished=True)

        self.assertEqual(result["media_asset_id"], _ASSET_ID)
        self.assertEqual(result["channel"], "crm")

    def test_clean_asset_records_usage_without_override(self):
        self.gateway._user_id = "user-1"
        self.gateway._role = "contributor"
        self.gateway.repository.fetch_one.return_value = {
            "id": _ASSET_ID, "needs_post_production": False, "has_open_report": False,
        }
        self._mock_insert(usage_id="cccccccc-dddd-eeee-ffff-000000000000")

        result = self.gateway.record_usage(_ASSET_ID, "facebook", note="launch post")

        self.assertEqual(result["usage_id"], "cccccccc-dddd-eeee-ffff-000000000000")
        self.assertEqual(result["media_asset_id"], _ASSET_ID)
        self.assertEqual(result["channel"], "facebook")


if __name__ == "__main__":
    unittest.main()
