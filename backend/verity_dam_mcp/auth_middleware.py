"""ASGI Authorization Middleware for VerityDAM MCP Server.

Accepts two kinds of HTTP Bearer token:

- API keys (``verity_mcp_live_*``) looked up by SHA-256 in public.mcp_api_keys;
- OAuth 2.1 access tokens (JWT) issued by the web app's Better Auth provider,
  verified against its JWKS (see ``oauth.py``); ``sub`` is the signed-in user.

Associates each valid request with the agent identity and role via
``scope["state"]`` and contextvars, rejecting other callers with HTTP 401. When
OAuth is enabled the 401 challenge carries RFC 9728 ``resource_metadata`` so MCP
clients can start the OAuth flow on their own.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import math
import os
import threading
import time
from collections import deque
from typing import Any, Callable

import anyio

from verity_dam_mcp.oauth import JwtAccessTokenVerifier, OAuthTokenError, looks_like_jwt

current_agent_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_agent_user_id", default=None
)
current_agent_role: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_agent_role", default=None
)
current_api_key_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_api_key_id", default=None
)

DEFAULT_RATE_LIMIT_PER_MINUTE = 60
SERVICE_NAME = "verity-dam-mcp"


def rate_limit_from_env() -> int:
    """MCP_RATE_LIMIT_PER_MINUTE (per API key / OAuth user); 0 disables the limiter."""
    raw = os.environ.get("MCP_RATE_LIMIT_PER_MINUTE", "").strip()
    if not raw:
        return DEFAULT_RATE_LIMIT_PER_MINUTE
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_RATE_LIMIT_PER_MINUTE


def mcp_protocol_version() -> str | None:
    try:
        import mcp_types

        return getattr(mcp_types, "LATEST_PROTOCOL_VERSION", None)
    except Exception:
        return None


class SlidingWindowRateLimiter:
    """In-process sliding 60 s window per caller (single server process)."""

    def __init__(self, limit_per_minute: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit_per_minute
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> int:
        """Record a hit. Return 0 if allowed, else seconds until a slot frees up."""
        if self.limit <= 0:
            return 0
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= 60.0:
                hits.popleft()
            if len(hits) >= self.limit:
                return max(1, math.ceil(60.0 - (now - hits[0])))
            hits.append(now)
            return 0


class ApiKeyAuthMiddleware:
    """Raw ASGI middleware enforcing HTTP Bearer authentication (API key or OAuth)."""

    def __init__(
        self,
        app: Any,
        repository: Any,
        rate_limiter: SlidingWindowRateLimiter | None = None,
        oauth_verifier: JwtAccessTokenVerifier | None = None,
    ) -> None:
        self.app = app
        self.repository = repository
        self.rate_limiter = rate_limiter or SlidingWindowRateLimiter(rate_limit_from_env())
        self.oauth_verifier = oauth_verifier
        challenge = 'Bearer realm="VerityDAM MCP"'
        if oauth_verifier is not None:
            challenge += f', resource_metadata="{oauth_verifier.config.resource_metadata_url}"'
        self._challenge = challenge

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        if method == "OPTIONS":
            # Allow CORS preflight requests without authentication
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in ("/health", "/ping"):
            # Answered here (no auth, no DB): liveness for compose healthchecks
            # and the settings page status probe.
            await self._send_json(
                send,
                200,
                {
                    "status": "ok",
                    "service": SERVICE_NAME,
                    "protocol_version": mcp_protocol_version(),
                    "rate_limit_per_minute": self.rate_limiter.limit,
                    "oauth": self.oauth_verifier is not None,
                },
            )
            return

        headers = dict(scope.get("headers", []))
        auth_bytes = headers.get(b"authorization")
        if not auth_bytes:
            await self._send_unauthorized(
                send, "Missing Authorization header. Expected 'Authorization: Bearer <token>'"
            )
            return

        auth_str = auth_bytes.decode("utf-8", errors="replace").strip()
        if not auth_str.startswith("Bearer "):
            await self._send_unauthorized(
                send, "Malformed Authorization header. Expected 'Bearer <token>'"
            )
            return

        raw_token = auth_str[7:].strip()
        if not raw_token:
            await self._send_unauthorized(send, "Empty Bearer token")
            return

        if self.oauth_verifier is not None and looks_like_jwt(raw_token):
            agent = await self._authenticate_oauth(send, raw_token)
        else:
            agent = await self._authenticate_api_key(send, raw_token)
        if agent is None:
            return

        rate_key = f"key:{agent['key_id']}" if agent["key_id"] else f"oauth:{agent['user_id']}"
        retry_after = self.rate_limiter.check(rate_key)
        if retry_after:
            await self._send_json(
                send,
                429,
                {
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32000,
                        "message": f"Rate limit exceeded: {self.rate_limiter.limit} requests/minute per API key or OAuth user",
                    },
                },
                extra_headers=[(b"retry-after", str(retry_after).encode("ascii"))],
            )
            return

        if agent["key_id"]:
            await self._touch_last_used(agent["key_id"])

        # Per-request identity for ToolGovernanceMiddleware / AuditMiddleware
        # (Starlette exposes scope["state"] as request.state).
        state = scope.setdefault("state", {})
        state["verity_agent"] = agent

        token_u = current_agent_user_id.set(agent["user_id"])
        token_r = current_agent_role.set(agent["role"])
        token_k = current_api_key_id.set(agent["key_id"])
        try:
            await self.app(scope, receive, send)
        finally:
            current_agent_user_id.reset(token_u)
            current_agent_role.reset(token_r)
            current_api_key_id.reset(token_k)

    async def _authenticate_api_key(self, send: Any, raw_token: str) -> dict[str, Any] | None:
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

        def _lookup_key() -> dict[str, Any] | None:
            return self.repository.fetch_one(
                """
                select k.id, k.user_id, k.role, k.name, u.role as user_role,
                       (k.expires_at is not null and k.expires_at <= now()) as expired
                from public.mcp_api_keys k
                join public."user" u on k.user_id = u.id
                where k.key_hash = %s and k.revoked_at is null
                limit 1
                """,
                (token_hash,),
            )

        try:
            row = await anyio.to_thread.run_sync(_lookup_key)
        except Exception as err:
            await self._send_json(
                send, 500, {"error": f"Internal authentication database error: {err}"}
            )
            return None

        if not row or not row.get("user_id"):
            await self._send_unauthorized(send, "Invalid or revoked API key")
            return None
        if row.get("expired"):
            await self._send_unauthorized(send, "API key has expired")
            return None
        return {
            "key_id": str(row["id"]),
            "user_id": str(row["user_id"]),
            "role": str(row.get("role") or row.get("user_role") or "viewer"),
            "name": row.get("name"),
            "auth": "api_key",
        }

    async def _authenticate_oauth(self, send: Any, raw_token: str) -> dict[str, Any] | None:
        verifier = self.oauth_verifier
        assert verifier is not None
        try:
            claims = await anyio.to_thread.run_sync(verifier.verify, raw_token)
        except OAuthTokenError as err:
            await self._send_unauthorized(send, str(err), error="invalid_token")
            return None
        except Exception:
            # JWKS endpoint unreachable etc.: a server fault, not a bad token.
            await self._send_json(send, 503, {"error": "OAuth signing keys are temporarily unavailable"})
            return None

        def _lookup_user() -> dict[str, Any] | None:
            return self.repository.fetch_one(
                'select id, email, role from public."user" where id::text = %s limit 1',
                (claims["sub"],),
            )

        try:
            user = await anyio.to_thread.run_sync(_lookup_user)
        except Exception as err:
            await self._send_json(
                send, 500, {"error": f"Internal authentication database error: {err}"}
            )
            return None
        if not user:
            await self._send_unauthorized(send, "OAuth user no longer exists", error="invalid_token")
            return None
        client_id = claims.get("client_id") or claims.get("azp")
        return {
            "key_id": None,
            "user_id": str(user["id"]),
            # Read live, so an admin's role change applies on the next call.
            "role": str(user.get("role") or "viewer"),
            "name": f"OAuth: {user.get('email')}",
            "auth": "oauth",
            "client_id": client_id,
        }

    async def _touch_last_used(self, key_id: str) -> None:
        def _update() -> None:
            with self.repository.transaction() as cur:
                cur.execute(
                    "update public.mcp_api_keys set last_used_at = now() where id = %s",
                    (key_id,),
                )

        try:
            await anyio.to_thread.run_sync(_update)
        except Exception:
            pass  # last_used_at is informational; never fail the call over it

    async def _send_unauthorized(self, send: Any, message: str, error: str | None = None) -> None:
        challenge = self._challenge + (f', error="{error}"' if error else "")
        await self._send_json(
            send,
            401,
            {
                "jsonrpc": "2.0",
                "error": {
                    "code": -32000,
                    "message": f"Unauthorized: {message}",
                },
            },
            extra_headers=[(b"www-authenticate", challenge.encode("ascii"))],
        )

    async def _send_json(
        self,
        send: Any,
        status: int,
        data: dict[str, Any],
        extra_headers: list[tuple[bytes, bytes]] | None = None,
    ) -> None:
        body = json.dumps(data).encode("utf-8")
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("ascii")),
        ]
        if extra_headers:
            headers.extend(extra_headers)
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})
