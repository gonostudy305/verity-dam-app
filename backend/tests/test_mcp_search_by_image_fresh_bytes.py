"""Unit tests for media_search_by_image with fresh image bytes.

Verifies that embedding.embed_image_bytes receives all required keyword arguments
(space_id, siglip2_model_path, openclip_model_path) and that active_space_id
is forwarded to match_media_assets_by_image_embedding without TypeError.
"""

from __future__ import annotations

import base64
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
    emb_mod.embed_image_bytes = MagicMock(return_value=[0.1, 0.2, 0.3])
    sys.modules["verity_dam_mcp.embedding"] = emb_mod

    lib_mod = types.ModuleType("verity_dam_mcp.library_search")
    lib_mod.build_retrieval_terms = MagicMock(return_value=[])
    lib_mod.rank_library_rows = MagicMock(return_value=[])
    sys.modules["verity_dam_mcp.library_search"] = lib_mod

    fmt_mod = types.ModuleType("verity_dam_mcp.formatting")
    fmt_mod.format_media_asset = MagicMock(side_effect=lambda row, signed_urls: dict(row))
    fmt_mod.render_assets_markdown = MagicMock(return_value="rendered_markdown")
    fmt_mod.render_json = MagicMock(return_value="{}")
    fmt_mod._truncate = MagicMock(side_effect=lambda text, limit=25_000: text)
    sys.modules["verity_dam_mcp.formatting"] = fmt_mod

    gw_mod = types.ModuleType("verity_dam_mcp.gateway")
    gw_mod.GatewayError = FakeGatewayError

    class _FakeGateway:
        def __init__(self, *a, **kw):
            self.space_resolver = MagicMock()
            self.space_resolver.get_active_space_id = MagicMock(return_value="test-space-id")

        def user_id(self):
            return "bot-stub"

        def rpc(self, name, params):
            return []

        def select(self, table, params):
            return []

        def create_signed_urls(self, paths):
            return {}

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
        siglip2_vision_model_path = "/models/siglip2.onnx"
        openclip_vision_model_path = "/models/openclip.onnx"

        @classmethod
        def from_environment(cls):
            return cls()

    settings_mod.McpSettings = _FakeSettings
    settings_mod.ConfigurationError = Exception
    sys.modules["verity_dam_mcp.settings"] = settings_mod


from verity_dam_mcp.models import SearchByImageInput  # noqa: E402

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


class SearchByImageFreshBytesTests(unittest.TestCase):
    def setUp(self):
        self.embed_patcher = patch.object(_srv.embedding, "embed_image_bytes", return_value=[0.1, 0.2, 0.3])
        self.mock_embed = self.embed_patcher.start()
        self.addCleanup(self.embed_patcher.stop)

        if not hasattr(_srv.gateway, "space_resolver") or _srv.gateway.space_resolver is None:
            _srv.gateway.space_resolver = MagicMock()
        _srv.gateway.rpc = MagicMock(return_value=[{"media_asset_id": "asset-1", "similarity": 0.85}])
        _srv.gateway.select = MagicMock(return_value=[{"id": "asset-1", "title": "Test Asset"}])

    def test_fresh_bytes_passes_required_kwargs_siglip2(self):
        _srv.gateway.space_resolver.get_active_space_id.return_value = "verity-siglip2-i18n-v1"
        payload_bytes = b"fake_siglip2_jpeg_data"
        encoded = base64.b64encode(payload_bytes).decode("ascii")

        params = SearchByImageInput(image_base64=encoded, response_format="markdown")
        result = _srv.media_search_by_image(params)

        self.mock_embed.assert_called_once_with(
            payload_bytes,
            space_id="verity-siglip2-i18n-v1",
            siglip2_model_path=_srv.settings.siglip2_vision_model_path,
            openclip_model_path=_srv.settings.openclip_vision_model_path,
        )
        _srv.gateway.rpc.assert_called_once()
        rpc_call = _srv.gateway.rpc.call_args
        self.assertEqual(rpc_call[0][0], "match_media_assets_by_image_embedding")
        self.assertEqual(rpc_call[0][1]["p_space_id"], "verity-siglip2-i18n-v1")
        self.assertEqual(result, "rendered_markdown")

    def test_fresh_bytes_passes_required_kwargs_datacomp(self):
        _srv.gateway.space_resolver.get_active_space_id.return_value = "verity-openclip-b32-datacomp-256-v1"
        payload_bytes = b"fake_datacomp_png_data"
        encoded = base64.b64encode(payload_bytes).decode("ascii")

        params = SearchByImageInput(image_base64=encoded, response_format="markdown")
        result = _srv.media_search_by_image(params)

        self.mock_embed.assert_called_once_with(
            payload_bytes,
            space_id="verity-openclip-b32-datacomp-256-v1",
            siglip2_model_path=_srv.settings.siglip2_vision_model_path,
            openclip_model_path=_srv.settings.openclip_vision_model_path,
        )
        rpc_call = _srv.gateway.rpc.call_args
        self.assertEqual(rpc_call[0][1]["p_space_id"], "verity-openclip-b32-datacomp-256-v1")

    def test_invalid_base64_returns_error_string(self):
        params = SearchByImageInput(image_base64="not-valid-base64!!")
        result = _srv.media_search_by_image(params)
        self.assertTrue(result.startswith("Error: image_base64 is not valid base64 data"))


if __name__ == "__main__":
    unittest.main()
