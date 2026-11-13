"""Unit tests for the synchronous text embedding service (Phase 5B)."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

import numpy as np
from fastapi.testclient import TestClient

from app.embedding_service import app, set_text_runtime
from app.siglip2_runtime import SIGLIP2_SPACE_ID


class EmbeddingServiceApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.mock_runtime = MagicMock()
        self.mock_runtime.space_id = SIGLIP2_SPACE_ID
        self.mock_runtime.dimension = 768
        self.mock_runtime.encode_text.return_value = np.zeros(768, dtype=np.float32)
        set_text_runtime(self.mock_runtime)

    def tearDown(self) -> None:
        set_text_runtime(None)

    def test_health_endpoint_returns_ok(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "OK")
        self.assertIn("uptime_seconds", data)

    def test_readiness_returns_503_when_uninitialized(self) -> None:
        set_text_runtime(None)
        response = self.client.get("/readiness")
        self.assertEqual(response.status_code, 503)
        data = response.json()
        self.assertEqual(data["status"], "INITIALIZING")

    def test_readiness_returns_200_when_ready(self) -> None:
        response = self.client.get("/readiness")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "READY")
        self.assertEqual(data["space_id"], SIGLIP2_SPACE_ID)
        self.assertEqual(data["dimension"], 768)
        self.assertTrue(data["model_loaded"])

    def test_embed_text_requires_valid_secret(self) -> None:
        response = self.client.post(
            "/embed/text",
            headers={"X-Verity-Shared-Secret": "wrong-secret"},
            json={"text": "khóa thông minh", "space_id": SIGLIP2_SPACE_ID},
        )
        self.assertEqual(response.status_code, 401)

    def test_embed_text_rejects_empty_query(self) -> None:
        response = self.client.post(
            "/embed/text",
            headers={"X-Verity-Shared-Secret": "dev-shared-secret"},
            json={"text": "   ", "space_id": SIGLIP2_SPACE_ID},
        )
        self.assertEqual(response.status_code, 400)

    def test_embed_text_rejects_unsupported_space(self) -> None:
        response = self.client.post(
            "/embed/text",
            headers={"X-Verity-Shared-Secret": "dev-shared-secret"},
            json={"text": "camera an ninh", "space_id": "verity-openclip-b32-datacomp-256-v1"},
        )
        self.assertEqual(response.status_code, 422)

    def test_embed_text_returns_embedding_vector(self) -> None:
        response = self.client.post(
            "/embed/text",
            headers={"X-Verity-Shared-Secret": "dev-shared-secret"},
            json={"text": "khóa cửa thông minh", "space_id": SIGLIP2_SPACE_ID},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["space_id"], SIGLIP2_SPACE_ID)
        self.assertEqual(data["dimension"], 768)
        self.assertEqual(len(data["embedding"]), 768)
        self.assertIn("latency_ms", data)
        self.mock_runtime.encode_text.assert_called_once_with("khóa cửa thông minh")


if __name__ == "__main__":
    unittest.main()
