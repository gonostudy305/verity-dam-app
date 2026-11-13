"""Decrypt the shared production Embedding API configuration from PostgreSQL."""

from __future__ import annotations

import base64
import binascii
import os
from dataclasses import replace
from typing import Any
from urllib.parse import urlparse

from app.production_config import (
    ConfigurationError,
    PRODUCTION_EMBEDDING_BASE_URL,
    PRODUCTION_EMBEDDING_MODEL,
    PRODUCTION_EMBEDDING_PROFILE,
    PRODUCTION_EMBEDDING_PROVIDER,
    PRODUCTION_EMBEDDING_VERSION,
    WorkerSettings,
)

AAD = b"verity:ai-embedding-config:v1"
ENCRYPTION_VERSION = 1


def _master_key() -> bytes:
    encoded = os.environ.get("Verity_VISION_CONFIG_MASTER_KEY", "").strip()
    try:
        key = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ConfigurationError("Verity_VISION_CONFIG_MASTER_KEY must be base64-encoded 32 bytes") from error
    if len(key) != 32:
        raise ConfigurationError("Verity_VISION_CONFIG_MASTER_KEY must be base64-encoded 32 bytes")
    return key


def _base64_field(record: dict[str, Any], name: str) -> bytes:
    value = record.get(name)
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"Shared Embedding configuration is missing {name}")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ConfigurationError(f"Shared Embedding configuration has invalid {name}") from error


def _decrypt_api_key(record: dict[str, Any]) -> str:
    if record.get("encryption_version") != ENCRYPTION_VERSION:
        raise ConfigurationError("Shared Embedding configuration has an unsupported encryption version")
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        ciphertext = _base64_field(record, "api_key_ciphertext")
        auth_tag = _base64_field(record, "api_key_auth_tag")
        nonce = _base64_field(record, "api_key_nonce")
        plaintext = AESGCM(_master_key()).decrypt(nonce, ciphertext + auth_tag, AAD).decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError, InvalidTag) as error:
        raise ConfigurationError("Shared Embedding API key could not be decrypted") from error
    if not plaintext:
        raise ConfigurationError("Shared Embedding API key was blank after decryption")
    return plaintext


def _validate_record(record: dict[str, Any]) -> None:
    base_url = record.get("base_url")
    parsed = urlparse(base_url) if isinstance(base_url, str) else None
    if (
        parsed is None
        or parsed.scheme != "https"
        or parsed.netloc != "api.example.com"
        or parsed.path.rstrip("/") != "/v1"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError("Shared Embedding base_url is not the approved 9Router endpoint")
    if record.get("model") != "jina-ai/jina-clip-v2":
        raise ConfigurationError("Shared Embedding model does not match the legacy API space")
    if record.get("embedding_version") != "jina-clip-v2-v1":
        raise ConfigurationError("Shared Embedding version does not match the legacy API space")
    if record.get("embedding_dimension") != 512:
        raise ConfigurationError("Shared Embedding dimension must be 512")


def apply_shared_embedding_config(settings: WorkerSettings, record: dict[str, Any]) -> WorkerSettings:
    """Return per-job settings with the decrypted key kept server-side."""
    _validate_record(record)
    return replace(
        settings,
        embedding_profile="legacy_api",
        embedding_provider=str(record.get("provider") or "jina_9router"),
        embedding_base_url=str(record.get("base_url") or "https://api.example.com/v1"),
        embedding_api_key=_decrypt_api_key(record),
        embedding_model=str(record.get("model") or "jina-ai/jina-clip-v2"),
        embedding_version=str(record.get("embedding_version") or "jina-clip-v2-v1"),
        embedding_dimension=512,
        embedding_input_mode="url",
    )
