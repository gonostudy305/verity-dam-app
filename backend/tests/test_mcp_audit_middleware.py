"""Unit tests for MCP audit logging middleware and sanitizers."""

from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from verity_dam_mcp.audit import AuditMiddleware, sanitize_params, sanitize_result


class AuditSanitizerTests(unittest.TestCase):
    def test_sanitize_params_redacts_base64_and_truncates_text(self):
        huge_base64 = "A" * 50_000
        long_article = "Đây là bài viết mô tả sản phẩm gia dụng Verity..." * 20
        raw_args = {
            "image_base64": huge_base64,
            "article_text": long_article,
            "channel": "facebook",
            "api_key": "secret-token-12345",
        }
        sanitized = sanitize_params(raw_args)

        self.assertNotIn("image_base64", sanitized)
        self.assertEqual(sanitized["image_base64_summary"]["length"], 50_000)
        self.assertIn("total", sanitized["article_text"])
        self.assertEqual(sanitized["channel"], "facebook")
        self.assertEqual(sanitized["api_key"], "[REDACTED]")

    def test_sanitize_result_handles_models_and_strings(self):
        class MockModel:
            def model_dump(self):
                return {
                    "fit_grade": 3,
                    "rationale": "Perfect match for smart door lock Acme M100",
                    "product_match": {"matched": True},
                    "already_used_recently": {"used": False},
                }

        summary = sanitize_result(MockModel())
        self.assertEqual(summary["fit_grade"], 3)
        self.assertTrue(summary["product_matched"])
        self.assertFalse(summary["already_used"])

        test_str = "Plain text result with 30 chars"
        text_summary = sanitize_result(test_str)
        self.assertEqual(text_summary["content_length"], len(test_str))
        self.assertEqual(text_summary["preview"], test_str)


class AuditMiddlewareTests(unittest.TestCase):
    def test_middleware_records_successful_tool_call(self):
        mock_gateway = MagicMock()
        middleware = AuditMiddleware(mock_gateway)

        ctx = SimpleNamespace(
            method="tools/call",
            params=SimpleNamespace(
                name="media_search",
                arguments={"params": {"query": "khoa thong minh", "limit": 5}},
            ),
        )

        async def _run():
            call_next = AsyncMock(return_value={"returned": 5, "total": 10})
            res = await middleware(ctx, call_next)
            return res

        result = asyncio.run(_run())
        self.assertEqual(result, {"returned": 5, "total": 10})
        mock_gateway.log_tool_call.assert_called_once()
        call_kwargs = mock_gateway.log_tool_call.call_args.kwargs
        self.assertEqual(call_kwargs["tool_name"], "media_search")
        self.assertEqual(call_kwargs["status"], "success")
        self.assertIsNone(call_kwargs["error_message"])
        self.assertGreaterEqual(call_kwargs["duration_ms"], 0)

    def test_middleware_records_error_and_reraises(self):
        mock_gateway = MagicMock()
        middleware = AuditMiddleware(mock_gateway)

        ctx = SimpleNamespace(
            method="tools/call",
            params={"name": "media_upload_asset", "arguments": {"filename": "bad.exe"}},
        )

        async def _run():
            call_next = AsyncMock(side_effect=RuntimeError("Unsupported file type"))
            await middleware(ctx, call_next)

        with self.assertRaises(RuntimeError):
            asyncio.run(_run())

        mock_gateway.log_tool_call.assert_called_once()
        call_kwargs = mock_gateway.log_tool_call.call_args.kwargs
        self.assertEqual(call_kwargs["tool_name"], "media_upload_asset")
        self.assertEqual(call_kwargs["status"], "error")
        self.assertIn("Unsupported file type", call_kwargs["error_message"])

    def test_middleware_ignores_non_tool_calls(self):
        mock_gateway = MagicMock()
        middleware = AuditMiddleware(mock_gateway)

        ctx = SimpleNamespace(method="initialize", params={})

        async def _run():
            call_next = AsyncMock(return_value="init_done")
            return await middleware(ctx, call_next)

        res = asyncio.run(_run())
        self.assertEqual(res, "init_done")
        mock_gateway.log_tool_call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
