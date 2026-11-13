"""Decrypt the shared Vision configuration fetched by the worker service role."""

from __future__ import annotations

import base64
import binascii
import os
from dataclasses import replace
from typing import Any
from urllib.parse import urlparse

from app.production_config import ConfigurationError, WorkerSettings

AAD = b"verity:ai-vision-config:v1"
ENCRYPTION_VERSION = 1
DEFAULT_ALLOWED_VISION_ORIGINS = {"https://api.example.com"}


def _allowed_vision_origins() -> set[str]:
    configured = (os.environ.get("VERITY_VISION_ALLOWED_ORIGINS") or os.environ.get("Verity_VISION_ALLOWED_ORIGINS", "")).strip()
    values = configured.split(",") if configured else DEFAULT_ALLOWED_VISION_ORIGINS
    origins: set[str] = set()
    for value in values:
        parsed = urlparse(value.strip())
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.path not in {"", "/"}
            or parsed.params
            or parsed.query
            or parsed.fragment
        ):
            raise ConfigurationError("Verity_VISION_ALLOWED_ORIGINS contains an invalid provider origin")
        origins.add(f"{parsed.scheme}://{parsed.netloc}".lower())
    if not origins:
        raise ConfigurationError("Verity_VISION_ALLOWED_ORIGINS must contain at least one provider origin")
    return origins


def _validate_allowed_vision_base_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}".lower()
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or origin not in _allowed_vision_origins()
    ):
        raise ConfigurationError("Shared Vision base_url is not an approved HTTPS provider origin")
    return base_url.rstrip("/")


def _master_key() -> bytes:
    encoded = (os.environ.get("VERITY_VISION_CONFIG_MASTER_KEY") or os.environ.get("Verity_VISION_CONFIG_MASTER_KEY", "")).strip()
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
        raise ConfigurationError(f"Shared Vision configuration is missing {name}")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ConfigurationError(f"Shared Vision configuration has invalid {name}") from error


def _decrypt_api_key(record: dict[str, Any]) -> str:
    if record.get("encryption_version") != ENCRYPTION_VERSION:
        raise ConfigurationError("Shared Vision configuration has an unsupported encryption version")
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as error:  # pragma: no cover - deployment dependency failure
        raise ConfigurationError("cryptography is required for shared Vision configuration") from error

    try:
        ciphertext = _base64_field(record, "api_key_ciphertext")
        auth_tag = _base64_field(record, "api_key_auth_tag")
        nonce = _base64_field(record, "api_key_nonce")
        plaintext = AESGCM(_master_key()).decrypt(nonce, ciphertext + auth_tag, AAD).decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError, InvalidTag) as error:
        raise ConfigurationError("Shared Vision API key could not be decrypted") from error
    if not plaintext:
        raise ConfigurationError("Shared Vision API key was blank after decryption")
    return plaintext


def apply_shared_vision_config(settings: WorkerSettings, record: dict[str, Any]) -> WorkerSettings:
    """Return per-job settings, never logging the decrypted credential."""
    base_url = record.get("base_url")
    model = record.get("model")
    detail = record.get("image_detail")
    max_tokens = record.get("max_tokens")
    system_prompt = record.get("system_prompt")
    if not isinstance(base_url, str):
        raise ConfigurationError("Shared Vision base_url must use HTTPS")
    if not isinstance(model, str) or not model.strip() or len(model) > 200:
        raise ConfigurationError("Shared Vision model is invalid")
    if detail not in {"auto", "low", "high"}:
        raise ConfigurationError("Shared Vision image_detail is invalid")
    if not isinstance(max_tokens, int) or not 256 <= max_tokens <= 4096:
        raise ConfigurationError("Shared Vision max_tokens is invalid")
    if not isinstance(system_prompt, str) or not system_prompt.strip() or len(system_prompt) > 8_000:
        raise ConfigurationError("Shared Vision system_prompt is invalid")
    return replace(
        settings,
        vision_base_url=_validate_allowed_vision_base_url(base_url),
        vision_api_key=_decrypt_api_key(record),
        vision_model=model.strip(),
        vision_detail=detail,
        vision_max_tokens=max_tokens,
        vision_system_prompt=system_prompt.strip(),
    )
