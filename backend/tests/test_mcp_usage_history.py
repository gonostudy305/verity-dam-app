"""Coverage for the media_get_usage_history MCP tool (Phase 3B).

Before this file, media_get_usage_history had zero test coverage anywhere in
the suite -- neither its happy path nor its error path (it does not catch
GatewayError, unlike the other 8 tools in server.py, so a role/DB failure
propagates as a raised exception rather than an "Error: ..." string; see
docs/mcp-server.md's "Error handling" note for why that's intentional here,
matching media_search's own contract).

Same stub-with-cleanup pattern as test_mcp_media_search.py: setUpModule/
tearDownModule scope the sys.modules patch to this file's own test run so it
cannot leak a fake verity_dam_mcp.embedding/gateway/... into any other test
file collected in the same pytest session.
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


from verity_dam_mcp.models import MediaUsageHistoryInput, MediaUsageHistoryOutput  # noqa: E402

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


class MediaGetUsageHistoryTest(unittest.TestCase):
    def _call(self, **kwargs):
        params = MediaUsageHistoryInput(asset_id="43a5a39e-7567-4103-a1ba-c602d76e361b", **kwargs)
        return _srv.media_get_usage_history(params)

    def test_happy_path_returns_structured_output(self):
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.fetch_usage_history.return_value = [
                {"channel": "facebook", "used_by": "marketing-bot", "note": "Q3 campaign", "used_at": "2026-09-01T00:00:00+00:00"},
                {"channel": "website", "used_by": "cms", "note": None, "used_at": "2026-09-03T00:00:00+00:00"},
            ]
            result = self._call(limit=10)

        mock_gw.fetch_usage_history.assert_called_once_with(
            "43a5a39e-7567-4103-a1ba-c602d76e361b", limit=10
        )
        self.assertIsInstance(result, MediaUsageHistoryOutput)
        self.assertEqual(result.total, 2)
        self.assertEqual(result.asset_id, "43a5a39e-7567-4103-a1ba-c602d76e361b")
        self.assertEqual(result.media_asset_id, "43a5a39e-7567-4103-a1ba-c602d76e361b")
        self.assertEqual(result.usages[0].channel, "facebook")
        self.assertIsNone(result.usages[1].note)

    def test_supports_canonical_media_asset_id_parameter(self):
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.fetch_usage_history.return_value = []
            params = MediaUsageHistoryInput(media_asset_id="11111111-2222-3333-4444-555555555555", limit=5)
            result = _srv.media_get_usage_history(params)

        mock_gw.fetch_usage_history.assert_called_once_with(
            "11111111-2222-3333-4444-555555555555", limit=5
        )
        self.assertEqual(result.media_asset_id, "11111111-2222-3333-4444-555555555555")
        self.assertEqual(result.asset_id, "11111111-2222-3333-4444-555555555555")

    def test_empty_history_returns_empty_list(self):
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.fetch_usage_history.return_value = []
            result = self._call()

        self.assertEqual(result.total, 0)
        self.assertEqual(result.usages, [])

    def test_role_not_allowed_propagates_gateway_error(self):
        # fetch_usage_history's own _require_role check (gateway.py) raises
        # GatewayError for a role outside viewer/contributor/reviewer/admin;
        # this tool does not catch it -- same intentional raise-based
        # contract as media_search, not an oversight (see module docstring).
        with patch.object(_srv, "gateway") as mock_gw:
            mock_gw.fetch_usage_history.side_effect = FakeGatewayError(
                "MCP account role 'unknown' is not allowed for this operation"
            )
            with self.assertRaises(FakeGatewayError):
                self._call()


if __name__ == "__main__":
    unittest.main()
