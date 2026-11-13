"""Coverage for the media_record_usage MCP tool (P1 gap fix).

Tests:
- happy path: approved asset, valid channel → returns RecordUsageOutput with usage_id
- phantom asset (not approved or deleted) → GatewayError propagates (not caught by tool)
- channel slug validation (min_length, max_length) caught by Pydantic before gateway
- note stored when provided, omitted when None

Same stub-with-cleanup pattern as test_mcp_usage_history.py.
"""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import MagicMock, patch


class FakeGatewayError(Exception):
    pass


def _stub_mcp_modules() -> None:
    mcp_mod = types.ModuleType("mcp")
    mcp_server_mod = types.ModuleType("mcp.server")

    class _FakeMCPServer:
        def __init__(self, *a, **kw):
            pass

        def tool(self, *a, **kw):
            def decorator(fn):
                return fn

            return decorator

    mcp_server_mod.MCPServer = _FakeMCPServer
    mcp_mod.server = mcp_server_mod
    sys.modules["mcp"] = mcp_mod
    sys.modules["mcp.server"] = mcp_server_mod

    mcp_types_mod = types.ModuleType("mcp_types")

    class _FakeToolAnnotations:
        def __init__(self, **kw):
            pass

    mcp_types_mod.ToolAnnotations = _FakeToolAnnotations
    sys.modules["mcp_types"] = mcp_types_mod

    emb_mod = types.ModuleType("verity_dam_mcp.embedding")
    emb_mod.ConfigurationError = Exception
    emb_mod.EmbeddingApiError = Exception
    sys.modules["verity_dam_mcp.embedding"] = emb_mod

    lib_mod = types.ModuleType("verity_dam_mcp.library_search")
    lib_mod.build_retrieval_terms = MagicMock(return_value=[])
    lib_mod.rank_library_rows = MagicMock(return_value=[])
    sys.modules["verity_dam_mcp.library_search"] = lib_mod

    fmt_mod = types.ModuleType("verity_dam_mcp.formatting")
    fmt_mod.format_media_asset = MagicMock(return_value="")
    fmt_mod.render_assets_markdown = MagicMock(return_value="")
    fmt_mod.render_json = MagicMock(return_value="{}")
    fmt_mod._truncate = MagicMock(side_effect=lambda text, limit=25_000: text)
    sys.modules["verity_dam_mcp.formatting"] = fmt_mod

    gw_mod = types.ModuleType("verity_dam_mcp.gateway")
    gw_mod.GatewayError = FakeGatewayError

    class _FakeGateway:
        def __init__(self, *a, **kw):
            pass

        def user_id(self):
            return "bot-stub"

    gw_mod.MediaMcpGateway = _FakeGateway
    sys.modules["verity_dam_mcp.gateway"] = gw_mod

    auth_mod = types.ModuleType("verity_dam_mcp.auth")

    class _FakeBotSession:
        def __init__(self, *a, **kw):
            pass

    auth_mod.BotSession = _FakeBotSession
    sys.modules["verity_dam_mcp.auth"] = auth_mod

    settings_mod = types.ModuleType("verity_dam_mcp.settings")

    class _FakeSettings:
        database_url = "postgresql://test:test@localhost/test"
        next_api_base_url = "http://localhost:3000"
        public_base_url = "https://dam.verity.internal"
        internal_service_key = "test-key"
        bot_user_id = "bot-uuid"

        @classmethod
        def from_environment(cls):
            return cls()

    settings_mod.McpSettings = _FakeSettings
    settings_mod.ConfigurationError = Exception
    sys.modules["verity_dam_mcp.settings"] = settings_mod


from verity_dam_mcp.models import RecordUsageInput, RecordUsageOutput  # noqa: E402

_STUBBED_MODULE_NAMES = (
    "mcp",
    "mcp.server",
    "mcp_types",
    "verity_dam_mcp.embedding",
    "verity_dam_mcp.library_search",
    "verity_dam_mcp.formatting",
    "verity_dam_mcp.gateway",
    "verity_dam_mcp.auth",
    "verity_dam_mcp.settings",
    "verity_dam_mcp.server",
)
_original_modules: dict[str, object] = {}
_srv = None

_ASSET_ID = "43a5a39e-7567-4103-a1ba-c602d76e361b"
_USAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def setUpModule() -> None:
    global _srv
    for name in _STUBBED_MODULE_NAMES:
        _original_modules[name] = sys.modules.get(name)
    _stub_mcp_modules()
    import verity_dam_mcp.server as srv_mod

    _srv = srv_mod


def tearDownModule() -> None:
    for name, original in _original_modules.items():
        if original is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = original
    _original_modules.clear()


class MediaRecordUsageTest(unittest.TestCase):
    def _call(self, channel: str = "facebook", **kwargs):
        params = RecordUsageInput(media_asset_id=_ASSET_ID, channel=channel, **kwargs)
        return _srv.media_record_usage(params)

    def test_happy_path_returns_record_usage_output(self):
        mock_result = {
            "usage_id": _USAGE_ID,
            "media_asset_id": _ASSET_ID,
            "channel": "facebook",
            "used_at": "2026-09-08T09:00:00+00:00",
        }
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.record_usage.return_value = mock_result
            result = self._call()

        mock_gw.record_usage.assert_called_once_with(
            asset_id=_ASSET_ID, channel="facebook", note=None, allow_unfinished=False
        )
        self.assertIsInstance(result, RecordUsageOutput)
        self.assertEqual(result.usage_id, _USAGE_ID)
        self.assertEqual(result.media_asset_id, _ASSET_ID)
        self.assertEqual(result.channel, "facebook")
        self.assertEqual(result.used_at, "2026-09-08T09:00:00+00:00")

    def test_note_forwarded_when_provided(self):
        mock_result = {
            "usage_id": _USAGE_ID,
            "media_asset_id": _ASSET_ID,
            "channel": "zalo",
            "used_at": "2026-09-08T09:00:00+00:00",
        }
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.record_usage.return_value = mock_result
            self._call(channel="zalo", note="Summer campaign post #42")

        mock_gw.record_usage.assert_called_once_with(
            asset_id=_ASSET_ID, channel="zalo", note="Summer campaign post #42", allow_unfinished=False
        )

    def test_allow_unfinished_forwarded_when_true(self):
        mock_result = {
            "usage_id": _USAGE_ID,
            "media_asset_id": _ASSET_ID,
            "channel": "crm",
            "used_at": "2026-09-08T09:00:00+00:00",
        }
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.record_usage.return_value = mock_result
            self._call(channel="crm", allow_unfinished=True)

        mock_gw.record_usage.assert_called_once_with(
            asset_id=_ASSET_ID, channel="crm", note=None, allow_unfinished=True
        )

    def test_needs_post_production_without_override_propagates_gateway_error(self):
        # server.py does not catch gateway errors -- the guard logic itself
        # (needs_post_production without allow_unfinished => raise) lives in
        # gateway.record_usage() and is covered directly against a real
        # repository mock in test_mcp_gateway_record_usage_guard.py; this
        # test only pins that media_record_usage does not swallow it.
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.record_usage.side_effect = FakeGatewayError(
                "flagged needs_post_production -- cannot record external usage"
            )
            with self.assertRaises(FakeGatewayError):
                self._call()

    def test_phantom_asset_propagates_gateway_error(self):
        # record_usage() in gateway raises GatewayError when asset is not
        # approved/found; media_record_usage does not catch it — same
        # intentional raise-based contract as media_search / media_get_usage_history.
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.record_usage.side_effect = FakeGatewayError(
                "Asset '...' not found, deleted, or not yet approved"
            )
            with self.assertRaises(FakeGatewayError):
                self._call()

    def test_empty_channel_rejected_by_pydantic(self):
        with self.assertRaises(Exception):
            RecordUsageInput(media_asset_id=_ASSET_ID, channel="")

    def test_channel_too_long_rejected_by_pydantic(self):
        with self.assertRaises(Exception):
            RecordUsageInput(media_asset_id=_ASSET_ID, channel="x" * 101)

    def test_note_over_500_chars_rejected_by_pydantic(self):
        with self.assertRaises(Exception):
            RecordUsageInput(media_asset_id=_ASSET_ID, channel="facebook", note="n" * 501)


if __name__ == "__main__":
    unittest.main()
