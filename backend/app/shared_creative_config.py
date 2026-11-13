"""Load the Settings-managed creative provider credentials.

The web app encrypts provider keys with the shared AES-GCM master key before
storing them in PostgreSQL. The creative worker decrypts only the provider it
needs for a claimed generation and never logs the plaintext credential.
"""

from __future__ import annotations

import base64
import binascii
import os
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse

from app.production_config import ConfigurationError

AAD = b"verity:ai-creative-config:v1"
ENCRYPTION_VERSION = 1


@dataclass(frozen=True)
class CreativeProviderConfig:
    base_url: str
    api_key: str


def _master_key() -> bytes:
    encoded = os.environ.get("Verity_VISION_CONFIG_MASTER_KEY", "").strip()
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ConfigurationError("Verity_VISION_CONFIG_MASTER_KEY must be base64-encoded 32 bytes") from error
    if len(key) != 32:
        raise ConfigurationError("Verity_VISION_CONFIG_MASTER_KEY must be base64-encoded 32 bytes")
    return key


def _decrypt(row: Mapping[str, Any], prefix: str) -> str | None:
    ciphertext = row.get(f"{prefix}_api_key_ciphertext")
    nonce = row.get(f"{prefix}_api_key_nonce")
    auth_tag = row.get(f"{prefix}_api_key_auth_tag")
    if not ciphertext and not nonce and not auth_tag:
        return None
    if not all(isinstance(value, str) and value for value in (ciphertext, nonce, auth_tag)):
        raise ConfigurationError(f"Creative {prefix} API key encryption fields are incomplete")
    if row.get("encryption_version") != ENCRYPTION_VERSION:
        raise ConfigurationError("Creative provider configuration has an unsupported encryption version")
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        encrypted = base64.b64decode(ciphertext, validate=True) + base64.b64decode(auth_tag, validate=True)
        plaintext = AESGCM(_master_key()).decrypt(base64.b64decode(nonce, validate=True), encrypted, AAD).decode("utf-8").strip()
    except (binascii.Error, ValueError, UnicodeDecodeError, InvalidTag) as error:
        raise ConfigurationError(f"Creative {prefix} API key could not be decrypted") from error
    if not plaintext:
        raise ConfigurationError(f"Creative {prefix} API key was blank after decryption")
    return plaintext


def _base_url(row: Mapping[str, Any], prefix: str) -> str:
    value = row.get(f"{prefix}_base_url")
    if not isinstance(value, str) or not value.strip():
        raise ConfigurationError(f"Creative {prefix} base URL is missing")
    parsed = urlparse(value.strip())
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigurationError(f"Creative {prefix} base URL must be HTTPS without credentials or query strings")
    return value.rstrip("/")


def load_shared_creative_config(repository: Any) -> dict[str, CreativeProviderConfig]:
    row = repository.fetch_one(
        """
        select openai_base_url, openai_api_key_ciphertext, openai_api_key_nonce, openai_api_key_auth_tag,
               gemini_base_url, gemini_api_key_ciphertext, gemini_api_key_nonce, gemini_api_key_auth_tag,
               encryption_version, active
          from public.verity_ai_creative_config
         where config_key = 'default' and active = true
         limit 1
        """
    )
    if not row:
        return {}
    configs: dict[str, CreativeProviderConfig] = {}
    for provider in ("openai", "gemini"):
        api_key = _decrypt(row, provider)
        if api_key:
            configs[provider] = CreativeProviderConfig(_base_url(row, provider), api_key)
    return configs
