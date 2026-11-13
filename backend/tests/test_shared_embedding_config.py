import base64
import os
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.production_config import ConfigurationError, WorkerSettings
from app.shared_embedding_config import AAD, apply_shared_embedding_config


class SharedEmbeddingConfigTests(unittest.TestCase):
    def setUp(self):
        self.master_key = os.urandom(32)
        self.api_key = "router_test_key"
        nonce = os.urandom(12)
        encrypted = AESGCM(self.master_key).encrypt(nonce, self.api_key.encode(), AAD)
        self.record = {
            "base_url": "https://api.example.com/v1",
            "model": "jina-ai/jina-clip-v2",
            "embedding_version": "jina-clip-v2-v1",
            "embedding_dimension": 512,
            "api_key_ciphertext": base64.b64encode(encrypted[:-16]).decode(),
            "api_key_nonce": base64.b64encode(nonce).decode(),
            "api_key_auth_tag": base64.b64encode(encrypted[-16:]).decode(),
            "encryption_version": 1,
        }
        self.settings = WorkerSettings(
            worker_id="test",
            poll_seconds=3,
            scene_duplicate_threshold=0.92,
            phash_max_distance=12,
            embedding_profile="production_api",
            embedding_provider="jina_9router",
            embedding_base_url="https://api.example.com/v1",
            embedding_api_key="",
            embedding_model="jina-ai/jina-clip-v2",
            embedding_version="jina-clip-v2-v1",
            embedding_dimension=512,
            embedding_input_mode="bytes",
            vision_base_url=None,
            vision_api_key=None,
            vision_model=None,
            vision_detail="high",
            vision_max_tokens=900,
            vision_system_prompt="",
            r2_endpoint=None,
            r2_access_key_id=None,
            r2_secret_access_key=None,
            r2_bucket=None,
            r2_region="auto",
            r2_public_base_url=None,
            database_url="postgresql://verity:password@postgres/verity_media",
        )

    def test_decrypts_key_and_returns_production_profile(self):
        with patch.dict(os.environ, {"Verity_VISION_CONFIG_MASTER_KEY": base64.b64encode(self.master_key).decode()}):
            settings = apply_shared_embedding_config(self.settings, self.record)
        self.assertEqual(settings.embedding_api_key, self.api_key)
        self.assertEqual(settings.embedding_model, "jina-ai/jina-clip-v2")
        self.assertEqual(settings.embedding_dimension, 512)

    def test_rejects_wrong_model_or_endpoint(self):
        for field, value in (("model", "other/model"), ("base_url", "https://attacker.invalid/v1")):
            record = {**self.record, field: value}
            with self.subTest(field=field):
                with patch.dict(os.environ, {"Verity_VISION_CONFIG_MASTER_KEY": base64.b64encode(self.master_key).decode()}):
                    with self.assertRaises(ConfigurationError):
                        apply_shared_embedding_config(self.settings, record)

    def test_rejects_tampered_ciphertext(self):
        record = {**self.record, "api_key_ciphertext": base64.b64encode(b"tampered").decode()}
        with patch.dict(os.environ, {"Verity_VISION_CONFIG_MASTER_KEY": base64.b64encode(self.master_key).decode()}):
            with self.assertRaises(ConfigurationError):
                apply_shared_embedding_config(self.settings, record)


if __name__ == "__main__":
    unittest.main()
