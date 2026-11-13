"""Entry point: ``python -m verity_dam_mcp`` runs the server over HTTP (SSE / Streamable HTTP) or stdio."""

import os
import sys

import anyio
import uvicorn

from verity_dam_mcp.auth_middleware import ApiKeyAuthMiddleware
from verity_dam_mcp.oauth import JwtAccessTokenVerifier, OAuthConfig
from verity_dam_mcp.server import gateway, server


async def run_server() -> None:
    transport = os.environ.get("MCP_TRANSPORT", "streamable-http").strip().lower()
    if len(sys.argv) > 1 and sys.argv[1] in {"stdio", "sse", "streamable-http", "http"}:
        transport = sys.argv[1]

    host = os.environ.get("MCP_HOST", "0.0.0.0")
    port = int(os.environ.get("MCP_PORT", "8000"))

    if transport == "stdio":
        await server.run_stdio_async()
        return

    if transport == "sse":
        sse_path = os.environ.get("MCP_SSE_PATH", "/sse")
        message_path = os.environ.get("MCP_MESSAGE_PATH", "/messages/")
        starlette_app = server.sse_app(
            sse_path=sse_path,
            message_path=message_path,
            host=host,
        )
    else:
        path = os.environ.get("MCP_PATH", "/mcp")
        starlette_app = server.streamable_http_app(
            streamable_http_path=path,
            host=host,
        )

    oauth_config = OAuthConfig.from_env()
    oauth_verifier = JwtAccessTokenVerifier(oauth_config) if oauth_config else None
    wrapped_app = ApiKeyAuthMiddleware(starlette_app, gateway.repository, oauth_verifier=oauth_verifier)
    config = uvicorn.Config(
        wrapped_app,
        host=host,
        port=port,
        log_level=server.settings.log_level.lower(),
    )
    uvicorn_server = uvicorn.Server(config)
    await uvicorn_server.serve()


if __name__ == "__main__":
    anyio.run(run_server)
