"""Tests for MCP tool governance (role + kill-switch) and the HTTP auth middleware."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from verity_dam_mcp.auth_middleware import ApiKeyAuthMiddleware, SlidingWindowRateLimiter
from verity_dam_mcp.governance import (
    TOOL_MIN_ROLE,
    ToolGovernanceMiddleware,
    required_role,
    role_allows,
)

ROOT = Path(__file__).resolve().parents[2]


def _tool_ctx(name: str, agent: dict | None = None) -> SimpleNamespace:
    request = SimpleNamespace(state=SimpleNamespace(verity_agent=agent)) if agent is not None else None
    return SimpleNamespace(method="tools/call", params={"name": name, "arguments": {}}, request=request)


def _repo(disabled: list[str] | None = None) -> MagicMock:
    """Fake gateway exposing .repository.fetch_all (what the middleware reads)."""
    gateway = MagicMock()
    gateway.repository.fetch_all.return_value = [{"tool_name": name} for name in (disabled or [])]
    return gateway


class RoleRuleTests(unittest.TestCase):
    def test_role_rank_is_monotonic(self):
        self.assertTrue(role_allows("viewer", "media_search"))
        self.assertFalse(role_allows("viewer", "media_upload_asset"))
        self.assertTrue(role_allows("contributor", "media_upload_asset"))
        self.assertFalse(role_allows("contributor", "media_resolve_review_item"))
        self.assertTrue(role_allows("reviewer", "media_resolve_review_item"))
        self.assertTrue(role_allows("admin", "media_save_crop"))

    def test_unknown_role_and_unknown_tool_fail_closed(self):
        self.assertFalse(role_allows(None, "media_search"))
        self.assertFalse(role_allows("superuser", "media_search"))
        self.assertEqual(required_role("media_brand_new_tool"), "reviewer")
        self.assertFalse(role_allows("contributor", "media_brand_new_tool"))

    def test_catalog_matches_registered_server_tools_and_frontend(self):
        server_src = (ROOT / "backend" / "verity_dam_mcp" / "server.py").read_text(encoding="utf-8")
        registered = set(re.findall(r"@server\.tool\([\s\S]*?\)\s*\ndef (\w+)\(", server_src))
        self.assertEqual(registered, set(TOOL_MIN_ROLE))

        catalog_src = (ROOT / "src" / "lib" / "mcp-catalog.ts").read_text(encoding="utf-8")
        frontend = dict(re.findall(r"name: '(\w+)',[\s\S]*?minRole: '(\w+)'", catalog_src))
        self.assertEqual(frontend, TOOL_MIN_ROLE)


class GovernanceMiddlewareTests(unittest.TestCase):
    def _run(self, middleware, ctx):
        call_next = AsyncMock(return_value="ok")
        result = asyncio.run(middleware(ctx, call_next))
        return result, call_next

    def test_non_tool_methods_pass_through(self):
        ctx = SimpleNamespace(method="tools/list", params=None, request=None)
        result, call_next = self._run(ToolGovernanceMiddleware(_repo()), ctx)
        self.assertEqual(result, "ok")
        call_next.assert_awaited_once()

    def test_low_role_is_denied_without_calling_tool(self):
        ctx = _tool_ctx("media_update_metadata", {"role": "viewer", "key_id": "k1"})
        result, call_next = self._run(ToolGovernanceMiddleware(_repo()), ctx)
        call_next.assert_not_awaited()
        self.assertTrue(result.is_error)
        self.assertTrue(result.content[0].text.startswith("Error:"))
        self.assertIn("requires 'reviewer'", result.content[0].text)

    def test_sufficient_role_is_allowed(self):
        ctx = _tool_ctx("media_update_metadata", {"role": "reviewer", "key_id": "k1"})
        result, call_next = self._run(ToolGovernanceMiddleware(_repo()), ctx)
        self.assertEqual(result, "ok")
        call_next.assert_awaited_once()

    def test_disabled_tool_is_denied_even_for_reviewer(self):
        ctx = _tool_ctx("media_save_crop", {"role": "reviewer", "key_id": "k1"})
        result, call_next = self._run(ToolGovernanceMiddleware(_repo(["media_save_crop"])), ctx)
        call_next.assert_not_awaited()
        self.assertIn("disabled", result.content[0].text)

    def test_stdio_without_agent_identity_is_allowed(self):
        ctx = _tool_ctx("media_search")
        result, _ = self._run(ToolGovernanceMiddleware(_repo()), ctx)
        self.assertEqual(result, "ok")

    def test_disabled_set_is_cached_and_survives_db_errors(self):
        now = [0.0]
        gateway = _repo(["media_save_crop"])
        middleware = ToolGovernanceMiddleware(gateway, clock=lambda: now[0])
        self.assertEqual(asyncio.run(middleware.disabled_tools()), {"media_save_crop"})
        asyncio.run(middleware.disabled_tools())
        self.assertEqual(gateway.repository.fetch_all.call_count, 1)
        now[0] = 100.0
        gateway.repository.fetch_all.side_effect = RuntimeError("db down")
        self.assertEqual(asyncio.run(middleware.disabled_tools()), {"media_save_crop"})


class RateLimiterTests(unittest.TestCase):
    def test_sliding_window(self):
        now = [0.0]
        limiter = SlidingWindowRateLimiter(2, clock=lambda: now[0])
        self.assertEqual(limiter.check("k"), 0)
        self.assertEqual(limiter.check("k"), 0)
        self.assertGreater(limiter.check("k"), 0)
        self.assertEqual(limiter.check("other"), 0)
        now[0] = 61.0
        self.assertEqual(limiter.check("k"), 0)

    def test_zero_disables(self):
        limiter = SlidingWindowRateLimiter(0)
        self.assertTrue(all(limiter.check("k") == 0 for _ in range(500)))


class AuthMiddlewareTests(unittest.TestCase):
    TOKEN = "verity_mcp_live_test"

    def _call(self, repo, headers=None, path="/mcp", limiter=None):
        sent: list[dict] = []
        app = AsyncMock()

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": path, "headers": headers or []}
        middleware = ApiKeyAuthMiddleware(app, repo, rate_limiter=limiter or SlidingWindowRateLimiter(60))
        asyncio.run(middleware(scope, AsyncMock(), send))
        status = sent[0]["status"] if sent else None
        body = json.loads(sent[1]["body"]) if len(sent) > 1 else None
        return status, body, sent, app, scope

    def _repo_with_key(self, **overrides):
        repo = MagicMock()
        row = {"id": "11111111-1111-1111-1111-111111111111", "user_id": "u1", "role": "viewer",
               "name": "Test agent", "user_role": "viewer", "expired": False}
        row.update(overrides)
        repo.fetch_one.return_value = row
        return repo

    def _auth(self):
        return [(b"authorization", f"Bearer {self.TOKEN}".encode())]

    def test_health_needs_no_auth_and_reports_config(self):
        status, body, _, app, _ = self._call(MagicMock(), path="/health", limiter=SlidingWindowRateLimiter(42))
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["rate_limit_per_minute"], 42)
        app.assert_not_awaited()

    def test_missing_header_is_401(self):
        status, _, sent, app, _ = self._call(MagicMock())
        self.assertEqual(status, 401)
        self.assertIn((b"www-authenticate", b'Bearer realm="VerityDAM MCP"'), sent[0]["headers"])
        app.assert_not_awaited()

    def test_expired_key_is_401(self):
        status, body, _, app, _ = self._call(self._repo_with_key(expired=True), headers=self._auth())
        self.assertEqual(status, 401)
        self.assertIn("expired", body["error"]["message"])
        app.assert_not_awaited()

    def test_valid_key_attaches_agent_and_looks_up_by_hash(self):
        repo = self._repo_with_key()
        _, _, _, app, scope = self._call(repo, headers=self._auth())
        app.assert_awaited_once()
        self.assertEqual(scope["state"]["verity_agent"]["role"], "viewer")
        self.assertEqual(scope["state"]["verity_agent"]["key_id"], "11111111-1111-1111-1111-111111111111")
        lookup_args = repo.fetch_one.call_args.args[1]
        self.assertEqual(lookup_args, (hashlib.sha256(self.TOKEN.encode()).hexdigest(),))

    def test_rate_limit_returns_429_with_retry_after(self):
        repo = self._repo_with_key()
        limiter = SlidingWindowRateLimiter(1)
        self._call(repo, headers=self._auth(), limiter=limiter)
        status, _, sent, app, _ = self._call(repo, headers=self._auth(), limiter=limiter)
        self.assertEqual(status, 429)
        self.assertTrue(any(name == b"retry-after" for name, _ in sent[0]["headers"]))
        app.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
