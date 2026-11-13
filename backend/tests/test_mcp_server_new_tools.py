"""Unit tests for the server tool wrappers of media_evaluate_image_fit and media_find_best_image_for_post."""

from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import MagicMock, patch


def _stub_mcp_modules() -> None:
    mcp_mod = types.ModuleType("mcp")
    mcp_server_mod = types.ModuleType("mcp.server")

    class _FakeMCPServer:
        def __init__(self, *a, **kw):
            self.tools = {}

        def tool(self, *a, **kw):
            def decorator(fn):
                self.tools[fn.__name__] = fn
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
    emb_mod.embed_image_bytes = MagicMock()
    emb_mod.embed_text = MagicMock()
    sys.modules["verity_dam_mcp.embedding"] = emb_mod

    lib_mod = types.ModuleType("verity_dam_mcp.library_search")
    lib_mod.build_retrieval_terms = MagicMock(return_value=[])
    lib_mod.rank_library_rows = MagicMock(return_value=[])
    sys.modules["verity_dam_mcp.library_search"] = lib_mod

    fmt_mod = types.ModuleType("verity_dam_mcp.formatting")
    fmt_mod.render_json = MagicMock(return_value="{}")
    fmt_mod.render_assets_markdown = MagicMock(return_value="")
    fmt_mod.format_media_asset = MagicMock(return_value={})
    fmt_mod._truncate = lambda x: x
    sys.modules["verity_dam_mcp.formatting"] = fmt_mod

    gw_mod = types.ModuleType("verity_dam_mcp.gateway")
    gw_mod.GatewayError = Exception
    gw_mod.MediaMcpGateway = MagicMock
    sys.modules["verity_dam_mcp.gateway"] = gw_mod

    auth_mod = types.ModuleType("verity_dam_mcp.auth")
    auth_mod.BotSession = MagicMock
    sys.modules["verity_dam_mcp.auth"] = auth_mod

    settings_mod = types.ModuleType("verity_dam_mcp.settings")

    class _FakeSettings:
        database_url = "postgresql://test:test@localhost:5432/test"
        r2_endpoint = "https://r2.test"
        r2_access_key_id = "test-key"
        r2_secret_access_key = "test-secret"
        r2_bucket = "test-bucket"
        r2_region = "auto"
        r2_public_base_url = "https://media.test"
        bot_email = "bot@veritydam.example"
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


from verity_dam_mcp.models import (
    ContextRelevance,
    EvaluateImageFitInput,
    EvaluateImageFitOutput,
    FindBestImageInput,
    FindBestImageOutput,
    ProductMatch,
    RecentUsageCheck,
    TechnicalSuitability,
)

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


class ServerToolRegistrationTests(unittest.TestCase):
    def test_media_evaluate_image_fit_delegates_properly(self):
        expected_output = EvaluateImageFitOutput(
            media_asset_id="11111111-1111-1111-1111-111111111111",
            fit_grade=3,
            fit_label="Ideal",
            rationale="Khớp hoàn hảo",
            context_relevance=ContextRelevance(relevance_score=0.95),
            technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
            product_match=ProductMatch(matched=True),
            already_used_recently=RecentUsageCheck(used=False),
        )

        with patch.object(_srv, "evaluate_image_fit", return_value=expected_output) as mock_eval:
            inp = EvaluateImageFitInput(
                article_text="Giới thiệu khóa Acme M100",
                media_asset_id="11111111-1111-1111-1111-111111111111",
                channel="facebook",
            )
            res = _srv.media_evaluate_image_fit(inp)

            mock_eval.assert_called_once_with(_srv.gateway, _srv.settings, inp)
            self.assertEqual(res.fit_grade, 3)
            self.assertEqual(res.fit_label, "Ideal")

    def test_media_find_best_image_for_post_delegates_properly(self):
        expected_output = FindBestImageOutput(
            best_pick=None,
            ranked_candidates=[],
            total_evaluated=0,
            channel="facebook",
        )

        with patch.object(_srv, "find_best_image", return_value=expected_output) as mock_find:
            inp = FindBestImageInput(
                post_text="Giới thiệu khóa Acme M100",
                channel="facebook",
            )
            res = _srv.media_find_best_image_for_post(inp)

            mock_find.assert_called_once_with(_srv.gateway, _srv.settings, _srv._run_media_search, inp)
            self.assertEqual(res.total_evaluated, 0)
            self.assertEqual(res.channel, "facebook")


if __name__ == "__main__":
    unittest.main()
