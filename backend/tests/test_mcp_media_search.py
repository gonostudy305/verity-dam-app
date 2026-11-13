"""Parity tests for the media_search MCP tool (Issue #51).

We stub out the mcp/mcp_types/settings/gateway dependencies so we can
import server.py in a plain unittest environment without the full MCP runtime.
IMPORTANT: Never mutate global os.environ at module level to avoid polluting other test suites!
"""

from __future__ import annotations

import json
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import httpx

# ---------------------------------------------------------------------------
# Stub the MCP runtime BEFORE server.py is imported
# ---------------------------------------------------------------------------

class FakeGatewayError(Exception):
    pass


def _stub_mcp_modules():
    """Insert minimal stubs so verity_dam_mcp.server can be imported."""
    # mcp.server.MCPServer
    mcp_mod = types.ModuleType("mcp")
    mcp_server_mod = types.ModuleType("mcp.server")
    class _FakeMCPServer:
        def __init__(self, *a, **kw): pass
        def tool(self, *a, **kw):
            def decorator(fn):
                return fn
            return decorator
    mcp_server_mod.MCPServer = _FakeMCPServer
    mcp_mod.server = mcp_server_mod
    sys.modules["mcp"] = mcp_mod
    sys.modules["mcp.server"] = mcp_server_mod

    # mcp_types.ToolAnnotations
    mcp_types_mod = types.ModuleType("mcp_types")
    class _FakeToolAnnotations:
        def __init__(self, **kw): pass
    mcp_types_mod.ToolAnnotations = _FakeToolAnnotations
    sys.modules["mcp_types"] = mcp_types_mod

    # verity_dam_mcp.embedding
    emb_mod = types.ModuleType("verity_dam_mcp.embedding")
    emb_mod.ConfigurationError = Exception
    emb_mod.EmbeddingApiError = Exception
    sys.modules["verity_dam_mcp.embedding"] = emb_mod

    # verity_dam_mcp.library_search
    lib_mod = types.ModuleType("verity_dam_mcp.library_search")
    lib_mod.build_retrieval_terms = MagicMock(return_value=[])
    lib_mod.rank_library_rows = MagicMock(return_value=[])
    sys.modules["verity_dam_mcp.library_search"] = lib_mod

    # verity_dam_mcp.formatting
    fmt_mod = types.ModuleType("verity_dam_mcp.formatting")
    fmt_mod.format_media_asset = MagicMock(return_value="")
    fmt_mod.render_assets_markdown = MagicMock(return_value="")
    fmt_mod.render_json = MagicMock(side_effect=json.dumps)
    fmt_mod._truncate = MagicMock(side_effect=lambda text, limit=25_000: text)
    sys.modules["verity_dam_mcp.formatting"] = fmt_mod

    # verity_dam_mcp.gateway
    gw_mod = types.ModuleType("verity_dam_mcp.gateway")
    gw_mod.GatewayError = FakeGatewayError
    class _FakeGateway:
        def __init__(self, *a, **kw): pass
        def user_id(self): return "bot-stub"
    gw_mod.MediaMcpGateway = _FakeGateway
    sys.modules["verity_dam_mcp.gateway"] = gw_mod

    # verity_dam_mcp.auth
    auth_mod = types.ModuleType("verity_dam_mcp.auth")
    class _FakeBotSession:
        def __init__(self, *a, **kw): pass
    auth_mod.BotSession = _FakeBotSession
    sys.modules["verity_dam_mcp.auth"] = auth_mod

    # verity_dam_mcp.settings
    settings_mod = types.ModuleType("verity_dam_mcp.settings")
    class _FakeSettings:
        database_url = "postgresql://test:test@localhost/test"
        next_api_base_url = "http://localhost:3000"
        public_base_url = "https://dam.verity.internal"
        internal_service_key = "test-key"
        bot_user_id = "bot-uuid"
        @classmethod
        def from_environment(cls): return cls()
    settings_mod.McpSettings = _FakeSettings
    settings_mod.ConfigurationError = Exception
    sys.modules["verity_dam_mcp.settings"] = settings_mod


from verity_dam_mcp.models import MediaSearchInput, MediaSearchOutput  # noqa: E402

# ---------------------------------------------------------------------------
# Module setup/teardown -- stub only for the lifetime of this file
# ---------------------------------------------------------------------------
#
# _stub_mcp_modules() used to run at module import time with no cleanup, so
# its fakes for verity_dam_mcp.embedding/gateway/auth/settings/... (and mcp,
# mcp.server, mcp_types) stayed in sys.modules for the rest of the pytest
# session. Any other test file collected afterward that needed the REAL
# module got this file's fake instead: e.g. `pytest test_mcp_media_search.py
# test_mcp_embedding.py` reproducibly fails test_mcp_embedding.py's
# collection with "cannot import name 'DATACOMP_SPACE_ID'" because it
# inherits this file's stub. setUpModule/tearDownModule scope the patch to
# this file's own test run, same as the os.environ warning above already
# asks for.
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
    "verity_dam_mcp.server",  # rebuilt against the stubs above; must not leak either
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_MINIMAL_RESULT = {
    "asset_id": "43a5a39e-7567-4103-a1ba-c602d76e361b",
    "title": "EDEN DEMO-007 Public Banner",
    "description": None,
    "thumbnail_url": "https://assets.verity.internal/thumb/eden-dl05.webp",
    "file_url": "https://assets.verity.internal/eden-dl05.webp",
    "cdn_key": "wp-content/uploads/2026/09/eden-demo-007-public-banner-1200x800.webp",
    "cdn_url": "https://assets.verity.internal/wp-content/uploads/2026/09/eden-demo-007-public-banner-1200x800.webp",
    "canonical_version": 3,
    "canonical_published_version": 3,
    "width": 1200,
    "height": 800,
    "permission": "public",
    "status": "approved",
    "canonical_sku_matches": [
        {
            "product_id": "prod-001",
            "code": "DEMO-007",
            "display_name": "EDEN Smart Lock DEMO-007",
            "brand": "EDEN",
            "category": "smart-lock",
            "role": "primary",
            "confidence": 0.98,
        }
    ],
    "match_reasons": ["exact_sku_match", "brand_model_match"],
    "product_safety": {
        "safe_for_exact_product_use": True,
        "verified_sku": "DEMO-007",
        "flag_details": {},
    },
    "score": 0.95,
}

_MINIMAL_RESPONSE = {
    "query": "khoa thong minh eden",
    "total": 1,
    "returned": 1,
    "results": [_MINIMAL_RESULT],
    "search_meta": {
        "used": True,
        "recovery_stage": None,
        "semantic_active": True,
        "detected_entities": {"brand": True, "sku": True},
        "actor_role": "reviewer",
    },
}


def _make_mock_response(body, status_code=200):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = body
    resp.text = json.dumps(body)
    resp.raise_for_status = MagicMock()
    if status_code >= 400:
        resp.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"HTTP {status_code}", request=MagicMock(), response=resp,
        )
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class MediaSearchMcpToolTest(unittest.TestCase):

    def _call(self, params_dict):
        params = MediaSearchInput(**params_dict)
        return _srv.media_search(params)

    def test_output_schema_is_defined(self):
        schema = MediaSearchOutput.model_json_schema()
        self.assertIn("properties", schema)
        props = schema["properties"]
        self.assertIn("query", props)
        self.assertIn("total", props)
        self.assertIn("returned", props)
        self.assertIn("results", props)
        self.assertIn("search_meta", props)
        self.assertIn("markdown_summary", props)

    def test_happy_path_returns_structured_output_model(self):
        mock_resp = _make_mock_response(_MINIMAL_RESPONSE)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp) as mock_post:
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            result = self._call({"query": "khoa thong minh eden"})

        mock_post.assert_called_once()
        headers = mock_post.call_args.kwargs["headers"]
        self.assertEqual(headers["x-actor-user-id"], "bot-user-uuid-001")
        self.assertIn("x-internal-service-key", headers)

        # Must return structured MediaSearchOutput model
        self.assertIsInstance(result, MediaSearchOutput)
        self.assertEqual(result.total, 1)
        self.assertEqual(len(result.results), 1)
        item = result.results[0]
        self.assertEqual(item.asset_id, "43a5a39e-7567-4103-a1ba-c602d76e361b")
        self.assertTrue(item.product_safety.safe_for_exact_product_use)
        self.assertIn("exact_sku_match", item.match_reasons)
        self.assertEqual(item.cdn_url, "https://assets.verity.internal/wp-content/uploads/2026/09/eden-demo-007-public-banner-1200x800.webp")
        self.assertEqual(item.file_url, item.cdn_url)
        self.assertEqual(item.thumbnail_url, item.cdn_url)
        self.assertEqual((item.width, item.height), (1200, 800))
        self.assertIsNotNone(result.markdown_summary)
        self.assertIn("EDEN DEMO-007 Public Banner", result.markdown_summary)
        self.assertIn("Canonical CDN URL", result.markdown_summary)
        self.assertIn("1200×800", result.markdown_summary)

    def test_legacy_result_without_canonical_rendition_remains_usable(self):
        """Unpublished assets keep their existing proxy/storage URLs."""
        item_data = {
            key: value
            for key, value in _MINIMAL_RESULT.items()
            if key not in {"cdn_key", "cdn_url", "canonical_version", "canonical_published_version", "width", "height"}
        }
        resp_body = {**_MINIMAL_RESPONSE, "results": [item_data]}
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            result = self._call({"query": "khoa thong minh eden"})

        item = result.results[0]
        self.assertIsNone(item.cdn_url)
        self.assertEqual(item.file_url, "https://assets.verity.internal/eden-dl05.webp")
        self.assertEqual(item.thumbnail_url, "https://assets.verity.internal/thumb/eden-dl05.webp")
        self.assertIsNone(item.width)
        self.assertIsNone(item.height)

    def test_relative_cdn_url_is_not_trusted_as_a_canonical_publishing_url(self):
        item_data = {
            **_MINIMAL_RESULT,
            "cdn_url": "/wp-content/uploads/2026/09/eden-demo-007-public-banner-1200x800.webp",
        }
        resp_body = {**_MINIMAL_RESPONSE, "results": [item_data]}
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            result = self._call({"query": "khoa thong minh eden"})

        item = result.results[0]
        self.assertIsNone(item.cdn_url)
        self.assertEqual(item.file_url, "https://assets.verity.internal/eden-dl05.webp")
        self.assertEqual(item.thumbnail_url, "https://assets.verity.internal/thumb/eden-dl05.webp")

    def test_invalid_cdn_url_is_not_promoted_to_the_legacy_url_fields(self):
        item_data = {
            **_MINIMAL_RESULT,
            "cdn_url": "https://example.invalid/not-a-wordpress-rendition.webp",
        }
        resp_body = {**_MINIMAL_RESPONSE, "results": [item_data]}
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            result = self._call({"query": "khoa thong minh eden"})

        item = result.results[0]
        self.assertIsNone(item.cdn_url)
        self.assertEqual(item.file_url, "https://assets.verity.internal/eden-dl05.webp")
        self.assertEqual(item.thumbnail_url, "https://assets.verity.internal/thumb/eden-dl05.webp")

    def test_timeout_raises_gateway_error(self):
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", side_effect=httpx.TimeoutException("timed out")):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            with self.assertRaises(FakeGatewayError) as ctx:
                self._call({"query": "camera ngoai troi"})
            self.assertIn("timed out", str(ctx.exception).lower())

    def test_http_error_raises_gateway_error(self):
        mock_resp = _make_mock_response({"error": "Forbidden"}, status_code=403)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            with self.assertRaises(FakeGatewayError) as ctx:
                self._call({"query": "camera"})
            self.assertIn("403", str(ctx.exception))

    def test_request_error_raises_gateway_error(self):
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", side_effect=httpx.ConnectError("connection refused")):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            with self.assertRaises(FakeGatewayError) as ctx:
                self._call({"query": "man hinh cam ung"})
            self.assertIn("connection refused", str(ctx.exception).lower())

    def test_parse_error_raises_gateway_error(self):
        mock_resp = _make_mock_response({})
        mock_resp.json.return_value = {"totally": "wrong"}
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            with self.assertRaises(FakeGatewayError) as ctx:
                self._call({"query": "robot hut bui"})
            self.assertIn("parse", str(ctx.exception).lower())

    def test_filters_forwarded_in_request_payload(self):
        resp_body = {**_MINIMAL_RESPONSE, "query": "robot", "total": 0, "returned": 0, "results": []}
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp) as mock_post:
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            self._call({
                "query": "robot",
                "category": "robot-vacuum",
                "permission": "public",
                "limit": 10,
                "offset": 20,
            })
        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["query"], "robot")
        self.assertEqual(sent["category"], "robot-vacuum")
        self.assertEqual(sent["permission"], "public")
        self.assertEqual(sent["limit"], 10)
        self.assertEqual(sent["offset"], 20)

    def test_none_fields_excluded_from_payload(self):
        resp_body = {**_MINIMAL_RESPONSE, "results": [], "total": 0, "returned": 0}
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp) as mock_post:
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            self._call({"query": "cua chong trom"})
        sent = mock_post.call_args.kwargs["json"]
        self.assertNotIn("category", sent)
        self.assertNotIn("space", sent)
        self.assertNotIn("status", sent)
    def test_include_reported_forwarded_in_request_payload(self):
        resp_body = {**_MINIMAL_RESPONSE, "query": "robot", "total": 0, "returned": 0, "results": []}
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp) as mock_post:
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            self._call({
                "query": "robot",
                "include_reported": True,
            })
        sent = mock_post.call_args.kwargs["json"]
        self.assertTrue(sent["include_reported"])

    def test_reported_asset_shows_warning_in_markdown_summary(self):
        item_data = {
            **_MINIMAL_RESULT,
            "has_open_report": True,
        }
        resp_body = {
            **_MINIMAL_RESPONSE,
            "results": [item_data],
            "total": 1,
            "returned": 1,
        }
        mock_resp = _make_mock_response(resp_body)
        with patch.object(_srv, "gateway") as mock_gw, \
             patch("httpx.post", return_value=mock_resp):
            mock_gw.user_id.return_value = "bot-user-uuid-001"
            result = self._call({"query": "camera"})
        self.assertIsNotNone(result.markdown_summary)
        self.assertIn("⚠️ REPORTED: Asset has an open issue report", result.markdown_summary)


if __name__ == "__main__":
    unittest.main()
