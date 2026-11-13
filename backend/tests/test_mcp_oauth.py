"""OAuth 2.1 resource-server tests for the VerityDAM MCP server."""

from __future__ import annotations

import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from verity_dam_mcp.auth_middleware import ApiKeyAuthMiddleware, SlidingWindowRateLimiter
from verity_dam_mcp.oauth import JwtAccessTokenVerifier, OAuthConfig, OAuthTokenError, looks_like_jwt

ENV = {
    "VERITY_MCP_PUBLIC_BASE_URL": "https://dam.example.test/",
    "NEXT_PUBLIC_APP_URL": "http://verity-dam-app:3000",
}
CONFIG = OAuthConfig.from_env(ENV)
USER_ID = "22222222-2222-2222-2222-222222222222"


class _FakeJwkClient:
    def __init__(self, public_key):
        self.public_key = public_key

    def get_signing_key_from_jwt(self, token):
        return SimpleNamespace(key=self.public_key)


def _keypair():
    private = Ed25519PrivateKey.generate()
    return private, private.public_key()


def _token(private, *, typ="at+jwt", **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": USER_ID,
        "aud": CONFIG.audience,
        "iss": CONFIG.issuer,
        "iat": now,
        "exp": now + 3600,
        "client_id": "client-abc",
        "scope": "openid offline_access",
    }
    claims.update(overrides)
    return jwt.encode(claims, private, algorithm="EdDSA", headers={"typ": typ})


class OAuthConfigTests(unittest.TestCase):
    def test_derives_issuer_audience_jwks_and_metadata_urls(self):
        self.assertEqual(CONFIG.issuer, "https://dam.example.test/api/auth")
        self.assertEqual(CONFIG.audience, "https://dam.example.test/mcp")
        self.assertEqual(CONFIG.jwks_url, "http://verity-dam-app:3000/api/auth/jwks")
        self.assertEqual(
            CONFIG.resource_metadata_url, "https://dam.example.test/.well-known/oauth-protected-resource/mcp"
        )

    def test_explicit_public_url_and_disable_switch(self):
        config = OAuthConfig.from_env({**ENV, "VERITY_MCP_PUBLIC_URL": "https://mcp.example.test/v1/mcp/"})
        self.assertEqual(config.audience, "https://mcp.example.test/v1/mcp")
        self.assertEqual(
            config.resource_metadata_url, "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp"
        )
        self.assertIsNone(OAuthConfig.from_env({**ENV, "MCP_OAUTH_ENABLED": "false"}))
        self.assertIsNone(OAuthConfig.from_env({}))

    def test_api_keys_are_never_treated_as_jwts(self):
        self.assertFalse(looks_like_jwt("verity_mcp_live_abc"))
        self.assertFalse(looks_like_jwt("verity_mcp_live_a.b.c"))
        self.assertTrue(looks_like_jwt("aaa.bbb.ccc"))


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.private, public = _keypair()
        self.verifier = JwtAccessTokenVerifier(CONFIG, jwk_client=_FakeJwkClient(public))

    def test_valid_token_returns_claims(self):
        claims = self.verifier.verify(_token(self.private))
        self.assertEqual(claims["sub"], USER_ID)
        self.assertEqual(claims["client_id"], "client-abc")

    def test_rejects_wrong_audience_issuer_expiry_and_type(self):
        cases = {
            "not issued for this MCP server": _token(self.private, aud="https://other.example/mcp"),
            "Invalid access token": _token(self.private, iss="https://evil.example/api/auth"),
            "expired": _token(self.private, iat=int(time.time()) - 7200, exp=int(time.time()) - 3600),
            "Not an OAuth access token": _token(self.private, typ="JWT"),
        }
        for message, token in cases.items():
            with self.subTest(message=message), self.assertRaisesRegex(OAuthTokenError, message):
                self.verifier.verify(token)

    def test_rejects_token_signed_by_another_key(self):
        other_private, _ = _keypair()
        with self.assertRaises(OAuthTokenError):
            self.verifier.verify(_token(other_private))

    def test_rejects_unsigned_token(self):
        unsigned = jwt.encode({"sub": USER_ID}, key=None, algorithm="none", headers={"typ": "at+jwt"})
        with self.assertRaisesRegex(OAuthTokenError, "Unsupported token algorithm"):
            self.verifier.verify(unsigned)


class OAuthMiddlewareTests(unittest.TestCase):
    def setUp(self):
        self.private, public = _keypair()
        self.verifier = JwtAccessTokenVerifier(CONFIG, jwk_client=_FakeJwkClient(public))

    def _call(self, repo, token=None):
        sent: list[dict] = []
        app = AsyncMock()

        async def send(message):
            sent.append(message)

        headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
        scope = {"type": "http", "method": "POST", "path": "/mcp", "headers": headers}
        middleware = ApiKeyAuthMiddleware(
            app, repo, rate_limiter=SlidingWindowRateLimiter(60), oauth_verifier=self.verifier
        )
        asyncio.run(middleware(scope, AsyncMock(), send))
        body = json.loads(sent[1]["body"]) if len(sent) > 1 else None
        return (sent[0]["status"] if sent else None), body, sent, app, scope

    @staticmethod
    def _challenge(sent) -> str:
        return dict(sent[0]["headers"])[b"www-authenticate"].decode()

    def test_challenge_advertises_protected_resource_metadata_and_keeps_realm(self):
        status, _, sent, app, _ = self._call(MagicMock())
        self.assertEqual(status, 401)
        challenge = self._challenge(sent)
        self.assertIn('realm="VerityDAM MCP"', challenge)
        self.assertIn(f'resource_metadata="{CONFIG.resource_metadata_url}"', challenge)
        app.assert_not_awaited()

    def test_valid_token_maps_subject_to_live_user_role(self):
        repo = MagicMock()
        repo.fetch_one.return_value = {"id": USER_ID, "email": "editor@example.test", "role": "reviewer"}
        _, _, _, app, scope = self._call(repo, _token(self.private))
        app.assert_awaited_once()
        agent = scope["state"]["verity_agent"]
        self.assertEqual(agent["role"], "reviewer")
        self.assertEqual(agent["user_id"], USER_ID)
        self.assertIsNone(agent["key_id"])
        self.assertEqual(agent["auth"], "oauth")
        self.assertEqual(agent["client_id"], "client-abc")
        self.assertEqual(repo.fetch_one.call_args.args[1], (USER_ID,))
        repo.transaction.assert_not_called()  # no API key row to touch

    def test_invalid_token_is_401_invalid_token_without_db_lookup(self):
        repo = MagicMock()
        status, _, sent, app, _ = self._call(repo, _token(self.private, aud="https://other.example/mcp"))
        self.assertEqual(status, 401)
        self.assertIn('error="invalid_token"', self._challenge(sent))
        repo.fetch_one.assert_not_called()
        app.assert_not_awaited()

    def test_deleted_user_is_rejected(self):
        repo = MagicMock()
        repo.fetch_one.return_value = None
        status, body, _, app, _ = self._call(repo, _token(self.private))
        self.assertEqual(status, 401)
        self.assertIn("no longer exists", body["error"]["message"])
        app.assert_not_awaited()

    def test_api_keys_still_work_when_oauth_is_enabled(self):
        repo = MagicMock()
        repo.fetch_one.return_value = {"id": "k1", "user_id": "u1", "role": "viewer", "name": "Bot",
                                       "user_role": "viewer", "expired": False}
        _, _, _, app, scope = self._call(repo, "verity_mcp_live_test")
        app.assert_awaited_once()
        self.assertEqual(scope["state"]["verity_agent"]["key_id"], "k1")
        self.assertEqual(scope["state"]["verity_agent"]["auth"], "api_key")

    def test_jwks_outage_is_503_not_401(self):
        class _Down:
            def get_signing_key_from_jwt(self, token):
                raise jwt.PyJWKClientConnectionError("jwks down")

        self.verifier = JwtAccessTokenVerifier(CONFIG, jwk_client=_Down())
        status, _, _, app, _ = self._call(MagicMock(), _token(self.private))
        self.assertEqual(status, 503)
        app.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
