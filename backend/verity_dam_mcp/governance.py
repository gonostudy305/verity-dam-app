"""Tool-level governance for the VerityDAM MCP server.

Runs before every ``tools/call``:

* minimum role per tool (defence in depth on top of the gateway's own
  ``_require_role`` checks, so a denial is uniform and audited);
* admin kill-switch per tool from ``public.mcp_tool_settings``.

``TOOL_MIN_ROLE`` must stay in sync with ``src/lib/mcp-catalog.ts`` (enforced
by ``tests/test_mcp_governance.py``).
"""

from __future__ import annotations

import time
from typing import Any, Callable

import anyio

ROLE_RANK: dict[str, int] = {"viewer": 0, "contributor": 1, "reviewer": 2, "admin": 3}

TOOL_MIN_ROLE: dict[str, str] = {
    "media_search": "viewer",
    "media_list_library": "viewer",
    "media_search_by_image": "viewer",
    "media_get_asset": "viewer",
    "media_evaluate_image_fit": "viewer",
    "media_find_best_image_for_post": "viewer",
    "media_get_usage_history": "viewer",
    "media_upload_asset": "contributor",
    "media_record_usage": "contributor",
    "media_list_pending_review": "reviewer",
    "media_resolve_review_item": "reviewer",
    "media_update_metadata": "reviewer",
    "media_save_crop": "reviewer",
}

# Tools not listed above (added later without a catalog entry) need the
# highest agent role rather than silently defaulting to open.
UNKNOWN_TOOL_MIN_ROLE = "reviewer"

_DISABLED_CACHE_SECONDS = 15.0


def required_role(tool_name: str) -> str:
    return TOOL_MIN_ROLE.get(tool_name, UNKNOWN_TOOL_MIN_ROLE)


def role_allows(role: str | None, tool_name: str) -> bool:
    if role is None:
        return False
    return ROLE_RANK.get(role, -1) >= ROLE_RANK[required_role(tool_name)]


def _denied(message: str) -> Any:
    # Imported lazily: unit tests stub `mcp_types` without the result models.
    from mcp_types import CallToolResult, TextContent

    # "Error:" prefix keeps AuditMiddleware's status detection consistent.
    return CallToolResult(content=[TextContent(type="text", text=f"Error: {message}")], isError=True)


def _tool_name(params: Any) -> str:
    if isinstance(params, dict):
        return str(params.get("name") or "")
    return str(getattr(params, "name", "") or "")


def request_agent(ctx: Any) -> dict[str, Any] | None:
    """Agent identity attached by ApiKeyAuthMiddleware to this HTTP request.

    Read from the per-message HTTP request (scope state) first; contextvars
    are a fallback because a streamable-HTTP session task inherits the
    context of the request that opened it, not of later requests.
    """
    request = getattr(ctx, "request", None)
    state = getattr(request, "state", None) if request is not None else None
    agent = getattr(state, "verity_agent", None) if state is not None else None
    if isinstance(agent, dict):
        return agent

    from verity_dam_mcp.auth_middleware import current_agent_role, current_api_key_id

    role = current_agent_role.get()
    if role:
        return {"role": role, "key_id": current_api_key_id.get()}
    return None


class ToolGovernanceMiddleware:
    """ServerMiddleware enforcing per-tool role and the admin kill-switch."""

    def __init__(self, gateway: Any, clock: Callable[[], float] = time.monotonic) -> None:
        # Holds the gateway (not its repository) so construction at import
        # time does not touch the database layer.
        self.gateway = gateway
        self._clock = clock
        self._disabled: frozenset[str] = frozenset()
        self._loaded_at: float | None = None

    def _load_disabled(self) -> frozenset[str]:
        rows = self.gateway.repository.fetch_all(
            "select tool_name from public.mcp_tool_settings where enabled = false"
        )
        return frozenset(str(row["tool_name"]) for row in rows or [])

    async def disabled_tools(self) -> frozenset[str]:
        now = self._clock()
        if self._loaded_at is None or now - self._loaded_at >= _DISABLED_CACHE_SECONDS:
            try:
                self._disabled = await anyio.to_thread.run_sync(self._load_disabled)
            except Exception:
                # Keep the last known switch state; a DB blip must not
                # re-enable a tool an admin turned off.
                pass
            self._loaded_at = now
        return self._disabled

    async def __call__(self, ctx: Any, call_next: Callable[[Any], Any]) -> Any:
        if getattr(ctx, "method", "") != "tools/call":
            return await call_next(ctx)

        tool_name = _tool_name(getattr(ctx, "params", None))
        if tool_name in await self.disabled_tools():
            return _denied(f"tool '{tool_name}' is disabled by the VerityDAM administrator")

        agent = request_agent(ctx)
        if agent is None:
            # No HTTP agent identity: stdio transport run locally by an
            # operator. HTTP requests always carry one (the auth middleware
            # rejects unauthenticated requests before they get here).
            return await call_next(ctx)

        role = agent.get("role")
        if not role_allows(role, tool_name):
            return _denied(
                f"API key role '{role}' cannot call '{tool_name}' (requires '{required_role(tool_name)}')"
            )
        return await call_next(ctx)
