"""Unit tests for MediaMcpGateway.log_tool_call."""

from __future__ import annotations

import io
import json
import sys
import unittest
from unittest.mock import MagicMock, patch

from verity_dam_mcp.gateway import MediaMcpGateway
from verity_dam_mcp.settings import McpSettings


class GatewayAuditLogTests(unittest.TestCase):
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

    def test_log_tool_call_executes_insert_with_sanitized_inputs(self):
        mock_cursor = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__.return_value = mock_cursor
        mock_ctx.__exit__.return_value = None
        self.gateway.repository.transaction.return_value = mock_ctx

        very_long_tool_name = "media_long_tool_" + ("x" * 200)
        very_long_error = "Error message " + ("e" * 3000)

        self.gateway.log_tool_call(
            tool_name=very_long_tool_name,
            bot_user_id="22222222-2222-2222-2222-222222222222",
            params_summary={"query": "test query"},
            result_summary={"total": 1},
            status="success",
            error_message=very_long_error,
            duration_ms=-10,
        )

        mock_cursor.execute.assert_called_once()
        sql, params = mock_cursor.execute.call_args[0]
        self.assertIn("insert into public.mcp_tool_call_log", sql)
        # Check tool_name truncated to <= 128
        self.assertLessEqual(len(params[0]), 128)
        # Check bot_user_id
        self.assertEqual(params[1], "22222222-2222-2222-2222-222222222222")
        # Check json payloads
        self.assertEqual(json.loads(params[2]), {"query": "test query"})
        self.assertEqual(json.loads(params[3]), {"total": 1})
        # Check status
        self.assertEqual(params[4], "success")
        # Check error_message truncated to <= 2000
        self.assertLessEqual(len(params[5]), 2000)
        # Check duration clamped to >= 0
        self.assertEqual(params[6], 0)

    def test_log_tool_call_never_raises_on_database_failure(self):
        self.gateway.repository.transaction.side_effect = RuntimeError("DB connection lost")

        stderr_trap = io.StringIO()
        with patch.object(sys, "stderr", stderr_trap):
            try:
                self.gateway.log_tool_call(
                    tool_name="media_search",
                    bot_user_id=None,
                    params_summary={},
                    result_summary={},
                    status="error",
                    error_message="some error",
                    duration_ms=15,
                )
            except Exception as e:
                self.fail(f"log_tool_call raised unexpectedly: {e}")

        self.assertIn("[Verity_MCP_AUDIT_LOG_ERROR]", stderr_trap.getvalue())


if __name__ == "__main__":
    unittest.main()
