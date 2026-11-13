"""Audit logging middleware and parameter sanitizers for VerityDAM MCP."""

from __future__ import annotations

import json
import time
from typing import Any, Callable

_SENSITIVE_KEYS = {"password", "token", "secret", "key", "authorization", "cookie"}
_BINARY_OR_LARGE_KEYS = {"image_base64", "content", "payload"}
_TEXT_KEYS = {"article_text", "post_text", "text", "query", "description", "caption"}


def sanitize_params(args: Any) -> dict[str, Any]:
    """Produce a safe, bounded JSON-serializable summary of tool input arguments."""
    if not isinstance(args, dict):
        if hasattr(args, "model_dump"):
            args = args.model_dump()
        elif hasattr(args, "__dict__"):
            args = dict(args.__dict__)
        else:
            return {"raw": str(args)[:300]}

    # If wrapped under a single "params" key (Pydantic model container)
    if "params" in args and isinstance(args["params"], (dict, object)) and len(args) == 1:
        inner = args["params"]
        if hasattr(inner, "model_dump"):
            args = inner.model_dump()
        elif isinstance(inner, dict):
            args = inner

    summary: dict[str, Any] = {}
    for key, value in args.items():
        k_lower = str(key).lower()
        if any(s in k_lower for s in _SENSITIVE_KEYS):
            summary[key] = "[REDACTED]"
        elif k_lower in _BINARY_OR_LARGE_KEYS and isinstance(value, str):
            summary[f"{key}_summary"] = {"length": len(value), "type": "base64_or_binary"}
        elif k_lower in _TEXT_KEYS and isinstance(value, str):
            if len(value) > 200:
                summary[key] = f"{value[:100]}... [total {len(value)} chars]"
            else:
                summary[key] = value
        elif isinstance(value, str):
            summary[key] = value[:300] if len(value) > 300 else value
        elif isinstance(value, (int, float, bool)) or value is None:
            summary[key] = value
        elif isinstance(value, list):
            summary[key] = {"count": len(value), "preview": [str(x)[:100] for x in value[:3]]}
        elif isinstance(value, dict):
            summary[key] = {"keys": list(value.keys())[:10], "count": len(value)}
        else:
            summary[key] = str(value)[:200]
    return summary


def sanitize_result(result: Any) -> dict[str, Any]:
    """Produce a safe, bounded JSON-serializable summary of tool output."""
    if result is None:
        return {"status": "none"}

    # If it's a Pydantic model
    if hasattr(result, "model_dump"):
        data = result.model_dump()
        # Specialized summaries for high-frequency return types
        if "fit_grade" in data:
            return {
                "fit_grade": data.get("fit_grade"),
                "rationale": str(data.get("rationale") or "")[:200],
                "product_matched": bool(data.get("product_match", {}).get("matched")),
                "already_used": bool(data.get("already_used_recently", {}).get("used")),
            }
        if "ranked_candidates" in data:
            return {
                "total_evaluated": data.get("total_evaluated"),
                "candidates_count": len(data.get("ranked_candidates") or []),
                "best_pick_grade": data.get("best_pick", {}).get("fit_grade") if data.get("best_pick") else None,
            }
        if "results" in data and "total" in data:
            return {
                "query": str(data.get("query") or "")[:100],
                "total": data.get("total"),
                "returned": data.get("returned"),
            }
        if "usage_id" in data:
            return {
                "usage_id": data.get("usage_id"),
                "channel": data.get("channel"),
            }
        # Fallback for other models: return keys and stringified values truncated
        return {k: str(v)[:200] for k, v in list(data.items())[:10]}

    if isinstance(result, dict):
        return {k: str(v)[:200] for k, v in list(result.items())[:10]}

    if isinstance(result, str):
        trimmed = result.strip()
        if trimmed.startswith("{") and trimmed.endswith("}"):
            try:
                parsed = json.loads(trimmed)
                if isinstance(parsed, dict):
                    return {k: str(v)[:200] for k, v in list(parsed.items())[:10]}
            except Exception:
                pass
        return {
            "content_length": len(result),
            "preview": result[:200] + ("..." if len(result) > 200 else ""),
        }

    return {"type": type(result).__name__, "str_preview": str(result)[:200]}


class AuditMiddleware:
    """ServerMiddleware implementation for recording MCP tool call activity."""

    def __init__(self, gateway: Any) -> None:
        self.gateway = gateway

    async def __call__(self, ctx: Any, call_next: Callable[[Any], Any]) -> Any:
        method = getattr(ctx, "method", "")
        if method != "tools/call":
            return await call_next(ctx)

        tool_name = "unknown"
        params_summary: dict[str, Any] = {}
        raw_params = getattr(ctx, "params", None)
        if raw_params:
            tool_name = getattr(raw_params, "name", None) or (
                raw_params.get("name") if isinstance(raw_params, dict) else "unknown"
            )
            args = getattr(raw_params, "arguments", None) or (
                raw_params.get("arguments") if isinstance(raw_params, dict) else {}
            )
            params_summary = sanitize_params(args)

        start = time.perf_counter()
        status = "success"
        error_message: str | None = None
        result: Any = None
        try:
            result = await call_next(ctx)
            return result
        except Exception as exc:
            status = "error"
            error_message = str(exc)
            raise
        finally:
            duration_ms = max(0, int((time.perf_counter() - start) * 1000))
            extracted_text: str | None = None
            if hasattr(result, "content") and isinstance(result.content, list):
                texts = [getattr(c, "text", "") for c in result.content if hasattr(c, "text")]
                extracted_text = "\n".join(t for t in texts if t)
            elif isinstance(result, str):
                extracted_text = result

            if status == "success" and extracted_text:
                trimmed_res = extracted_text.strip()
                if (
                    trimmed_res.startswith("Error:")
                    or trimmed_res.startswith("Error ")
                    or trimmed_res.startswith("Error listing media:")
                ):
                    status = "error"
                    error_message = trimmed_res[:2000]
            elif status == "success" and isinstance(result, dict) and "error" in result:
                status = "error"
                error_message = str(result["error"])[:2000]
            elif (
                status == "success"
                and hasattr(result, "structured_content")
                and isinstance(result.structured_content, dict)
                and "error" in result.structured_content
            ):
                status = "error"
                error_message = str(result.structured_content["error"])[:2000]

            result_summary = (
                sanitize_result(result)
                if status == "success"
                else {"error": str(error_message)[:300]}
            )
            from verity_dam_mcp.auth_middleware import current_agent_user_id
            from verity_dam_mcp.governance import request_agent

            agent = request_agent(ctx) or {}
            bot_user_id = (
                agent.get("user_id") or current_agent_user_id.get() or getattr(self.gateway, "_user_id", None)
            )
            try:
                self.gateway.log_tool_call(
                    tool_name=tool_name,
                    bot_user_id=bot_user_id,
                    params_summary=params_summary,
                    result_summary=result_summary,
                    status=status,
                    error_message=error_message,
                    duration_ms=duration_ms,
                    api_key_id=agent.get("key_id"),
                )
            except Exception:
                pass
