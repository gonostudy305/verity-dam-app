"""Coverage for media_upload_asset's server-side SHA-256 hashing, exact-duplicate
refusal, and source_ref passthrough.

Same stub-with-cleanup pattern as test_mcp_record_usage.py.
"""

from __future__ import annotations

import base64
import hashlib
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

from pydantic import ValidationError


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


from verity_dam_mcp.models import UploadAssetInput  # noqa: E402

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

_BYTES = b"fake-jpeg-bytes"
_B64 = base64.b64encode(_BYTES).decode()
_SHA = hashlib.sha256(_BYTES).hexdigest()


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


def _params(**kwargs) -> UploadAssetInput:
    return UploadAssetInput(
        image_base64=_B64, filename="zalo-1.jpg", media_type="photo", permission="internal", **kwargs
    )


class UploadDedupTest(unittest.TestCase):
    def test_new_file_forwards_server_hash_and_source_ref(self):
        with patch.object(_srv, "gateway") as gw:
            gw.user_id.return_value = "bot-1"
            gw.find_asset_by_content_hash.return_value = None
            gw.rpc.return_value = [{"media_asset_id": "a-1", "review_queue_id": "q-1"}]
            out = _srv.media_upload_asset(_params(source_ref="zalo:marketing:123"))

        gw.find_asset_by_content_hash.assert_called_once_with(_SHA)
        gw.upload_object.assert_called_once()
        upload_item = gw.rpc.call_args[0][1]["p_uploads"][0]
        self.assertEqual(upload_item["sha256"], _SHA)
        self.assertEqual(upload_item["source_ref"], "zalo:marketing:123")
        self.assertIn("Upload accepted", out)
        self.assertIn(_SHA, out)

    def test_exact_duplicate_is_skipped_without_storing(self):
        with patch.object(_srv, "gateway") as gw:
            gw.user_id.return_value = "bot-1"
            gw.find_asset_by_content_hash.return_value = {
                "id": "old-asset",
                "review_state": "approved",
                "review_queue_id": "old-queue",
            }
            out = _srv.media_upload_asset(_params())

        gw.upload_object.assert_not_called()
        gw.rpc.assert_not_called()
        self.assertIn("Upload skipped (exact duplicate)", out)
        self.assertIn("duplicate_of_media_asset_id: `old-asset`", out)
        self.assertIn("review_state: approved", out)

    def test_client_sha256_mismatch_is_rejected_before_any_lookup(self):
        with patch.object(_srv, "gateway") as gw:
            out = _srv.media_upload_asset(_params(sha256="0" * 64))

        self.assertTrue(out.startswith("Error: sha256 does not match"))
        gw.find_asset_by_content_hash.assert_not_called()
        gw.upload_object.assert_not_called()

    def test_uppercase_client_sha256_is_accepted(self):
        with patch.object(_srv, "gateway") as gw:
            gw.user_id.return_value = "bot-1"
            gw.find_asset_by_content_hash.return_value = None
            gw.rpc.return_value = [{"media_asset_id": "a-1", "review_queue_id": "q-1"}]
            out = _srv.media_upload_asset(_params(sha256=_SHA.upper()))

        self.assertIn("Upload accepted", out)

    def test_role_error_from_lookup_blocks_the_upload(self):
        with patch.object(_srv, "gateway") as gw:
            gw.user_id.return_value = "bot-1"
            gw.find_asset_by_content_hash.side_effect = FakeGatewayError("role 'viewer' is not allowed")
            out = _srv.media_upload_asset(_params())

        self.assertTrue(out.startswith("Error"))
        gw.upload_object.assert_not_called()

    def test_malformed_sha256_fails_input_validation(self):
        with self.assertRaises(ValidationError):
            _params(sha256="not-a-hash")

    def test_source_ref_length_is_capped(self):
        with self.assertRaises(ValidationError):
            _params(source_ref="x" * 201)


if __name__ == "__main__":
    unittest.main()
