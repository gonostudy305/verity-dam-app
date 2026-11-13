"""OAuth 2.1 resource-server support for the VerityDAM MCP server.

The Next.js app is the authorization server (Better Auth ``mcp()`` plugin).
It issues EdDSA-signed JWT access tokens (``typ: at+jwt``) whose audience is
the public MCP URL. This module verifies them against the app's JWKS; the
middleware then maps ``sub`` to the user's current role in the database.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

import jwt

ACCESS_TOKEN_TYP = "at+jwt"
ALLOWED_ALGORITHMS = ["EdDSA", "ES256", "RS256", "PS256"]
JWKS_CACHE_SECONDS = 300
CLOCK_SKEW_SECONDS = 30


class OAuthTokenError(Exception):
    """The bearer token is not a valid access token for this MCP server."""


def looks_like_jwt(token: str) -> bool:
    return token.count(".") == 2 and not token.startswith("verity_mcp_")


@dataclass(frozen=True)
class OAuthConfig:
    issuer: str
    audience: str
    jwks_url: str
    resource_metadata_url: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "OAuthConfig | None":
        """Derived from the URLs the MCP container already has; None disables OAuth.

        - issuer: VERITY_MCP_PUBLIC_BASE_URL (= BETTER_AUTH_URL) + /api/auth
        - audience: VERITY_MCP_PUBLIC_URL, else base + /mcp
        - JWKS: fetched over the internal network (NEXT_PUBLIC_APP_URL)
        """
        env = os.environ if env is None else env
        if env.get("MCP_OAUTH_ENABLED", "true").strip().lower() in {"0", "false", "no", "off"}:
            return None
        base = (env.get("VERITY_MCP_PUBLIC_BASE_URL") or "").strip().rstrip("/")
        if not base:
            return None
        audience = (env.get("VERITY_MCP_PUBLIC_URL") or "").strip().rstrip("/") or f"{base}/mcp"
        internal_app = (env.get("NEXT_PUBLIC_APP_URL") or base).strip().rstrip("/")
        jwks_url = (env.get("MCP_OAUTH_JWKS_URL") or "").strip() or f"{internal_app}/api/auth/jwks"
        parts = urlsplit(audience)
        resource_metadata_url = (
            f"{parts.scheme}://{parts.netloc}/.well-known/oauth-protected-resource{parts.path.rstrip('/')}"
        )
        return cls(
            issuer=f"{base}/api/auth",
            audience=audience,
            jwks_url=jwks_url,
            resource_metadata_url=resource_metadata_url,
        )


class JwtAccessTokenVerifier:
    """Verifies Better Auth OAuth access tokens. Blocking (JWKS fetch): run in a thread."""

    def __init__(self, config: OAuthConfig, jwk_client: Any | None = None) -> None:
        self.config = config
        self._jwk_client = jwk_client or jwt.PyJWKClient(
            config.jwks_url, cache_keys=True, lifespan=JWKS_CACHE_SECONDS, timeout=5
        )

    def verify(self, token: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as err:
            raise OAuthTokenError("Malformed access token") from err
        if header.get("typ") != ACCESS_TOKEN_TYP:
            raise OAuthTokenError("Not an OAuth access token")
        if header.get("alg") not in ALLOWED_ALGORITHMS:
            raise OAuthTokenError("Unsupported token algorithm")
        try:
            signing_key = self._jwk_client.get_signing_key_from_jwt(token)
        except jwt.PyJWKClientConnectionError:
            raise  # JWKS unreachable: a server fault, not a bad token
        except jwt.PyJWTError as err:
            raise OAuthTokenError("Unknown signing key") from err
        try:
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=[header["alg"]],
                audience=self.config.audience,
                issuer=self.config.issuer,
                leeway=CLOCK_SKEW_SECONDS,
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.ExpiredSignatureError as err:
            raise OAuthTokenError("Access token has expired") from err
        except jwt.InvalidAudienceError as err:
            raise OAuthTokenError("Access token was not issued for this MCP server") from err
        except jwt.PyJWTError as err:
            raise OAuthTokenError("Invalid access token") from err
        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise OAuthTokenError("Access token has no subject")
        return claims
