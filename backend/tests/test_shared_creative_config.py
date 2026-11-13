import base64
import os
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.shared_creative_config import AAD, load_shared_creative_config


class _Repository:
    def __init__(self, row):
        self.row = row

    def fetch_one(self, query):
        return self.row


def _encrypted(value: str, key: bytes) -> tuple[str, str, str]:
    nonce = b"0123456789ab"
    encrypted = AESGCM(key).encrypt(nonce, value.encode(), AAD)
    return (
        base64.b64encode(encrypted[:-16]).decode(),
        base64.b64encode(nonce).decode(),
        base64.b64encode(encrypted[-16:]).decode(),
    )


class SharedCreativeConfigTests(unittest.TestCase):
    def test_settings_key_is_decrypted_without_exposing_other_provider(self):
        key = bytes(range(32))
        ciphertext, nonce, auth_tag = _encrypted("openai-secret", key)
        row = {
            "openai_base_url": "https://gateway.example/v1",
            "openai_api_key_ciphertext": ciphertext,
            "openai_api_key_nonce": nonce,
            "openai_api_key_auth_tag": auth_tag,
            "gemini_base_url": "https://generativelanguage.googleapis.com/v1beta",
            "gemini_api_key_ciphertext": None,
            "gemini_api_key_nonce": None,
            "gemini_api_key_auth_tag": None,
            "encryption_version": 1,
            "active": True,
        }
        encoded = base64.b64encode(key).decode()
        with patch.dict(os.environ, {"Verity_VISION_CONFIG_MASTER_KEY": encoded}, clear=False):
            configs = load_shared_creative_config(_Repository(row))
        self.assertEqual(configs["openai"].api_key, "openai-secret")
        self.assertNotIn("gemini", configs)


if __name__ == "__main__":
    unittest.main()
