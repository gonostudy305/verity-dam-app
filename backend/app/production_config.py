"""Configuration for the long-running native PostgreSQL/R2 worker.

All secrets stay server-side. The browser only talks to the Next.js API and
never receives database, vision, embedding, or R2 credentials.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _ROOT.parent

# Load local overrides (.env.local) first, followed by default .env
load_dotenv(_REPO_ROOT / ".env.local")
load_dotenv(_REPO_ROOT / ".env")
load_dotenv(_ROOT / ".env.local")
load_dotenv(_ROOT / ".env")


class ConfigurationError(RuntimeError):
    pass


PRODUCTION_EMBEDDING_PROFILE = "local_siglip2"
PRODUCTION_EMBEDDING_PROVIDER = "local_siglip2"
PRODUCTION_EMBEDDING_BASE_URL = "https://api.example.com/v1"
PRODUCTION_EMBEDDING_MODEL = "siglip2-b32-256-webli"
PRODUCTION_EMBEDDING_VERSION = "v1"
PRODUCTION_EMBEDDING_DIMENSION = 768
CANONICAL_SPACE_ID = "verity-siglip2-b32-256-webli-v1"
# SigLIP2 has separate vision/text graphs and external-data files.  There is
# deliberately no single model-file SHA here; artifact_manifest.json is the
# provenance authority for all four runtime artifacts.
SIGLIP2_ARTIFACT_MANIFEST_PATH = "backend/benchmarks/siglip2/artifact_manifest.json"
SIGLIP2_VISION_GRAPH_NAME = "siglip2-vision-opset18.onnx"
SIGLIP2_TEXT_GRAPH_NAME = "siglip2-text-opset18.onnx"


def _required_fixed_value(name: str, expected: str) -> str:
    value = os.environ.get(name, expected).strip()
    if value != expected:
        raise ConfigurationError(
            f"{name} must remain {expected!r}; changing the embedding space requires a new migration"
        )
    return expected


def _optional_positive_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be an integer") from error
    if not minimum <= parsed <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _optional_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        parsed = float(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number") from error
    if not minimum <= parsed <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return parsed


def _optional_https_url(name: str) -> str | None:
    value = os.environ.get(name, "").strip().rstrip("/")
    if not value:
        return None
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError(f"{name} must be an HTTPS URL without credentials, query, or fragment")
    return value


@dataclass(frozen=True)
class WorkerSettings:
    """Configuration shared by the native worker and its provider adapters."""

    worker_id: str
    poll_seconds: int
    scene_duplicate_threshold: float
    phash_max_distance: int
    embedding_profile: str
    embedding_provider: str
    embedding_base_url: str
    # Loaded at job runtime from the encrypted provider configuration record.
    # It is intentionally not required in the worker environment.
    embedding_api_key: str
    embedding_model: str
    embedding_version: str
    embedding_dimension: int
    embedding_input_mode: str
    vision_base_url: str | None
    vision_api_key: str | None
    vision_model: str | None
    vision_detail: str
    vision_max_tokens: int
    vision_system_prompt: str
    r2_endpoint: str | None
    r2_access_key_id: str | None
    r2_secret_access_key: str | None
    r2_bucket: str | None
    r2_region: str
    r2_public_base_url: str | None
    # Optional in hand-built unit-test fixtures; production loading always
    # obtains it from PostgresSettings.from_environment().
    database_url: str | None = None
    db_min_connections: int = 1
    db_max_connections: int = 8
    db_connect_timeout: int = 10

    def __repr__(self) -> str:
        """Avoid exposing database, AI, or R2 credentials in logs."""

        return (
            "WorkerSettings("
            f"worker_id={self.worker_id!r}, database_configured={bool(self.database_url)}, "
            f"embedding_profile={self.embedding_profile!r}, embedding_api_key_configured={bool(self.embedding_api_key)}, "
            f"r2_configured={self.r2_is_configured})"
        )

    @classmethod
    def from_environment(cls) -> "WorkerSettings":
        try:
            from app.postgres_repository import PostgresSettings

            database = PostgresSettings.from_environment()
        except Exception as error:  # normalize dependency/config errors
            if isinstance(error, ConfigurationError):
                raise
            raise ConfigurationError(str(error)) from error
        database_url = database.database_url
        db_min_connections = database.min_connections
        db_max_connections = database.max_connections
        db_connect_timeout = database.connect_timeout
        embedding_profile = os.environ.get("Verity_EMBEDDING_PROFILE", PRODUCTION_EMBEDDING_PROFILE).strip()
        # legacy_api is intentionally disabled: runtime-switching the encoder creates cross-space
        # contamination (Jina vectors ↔ B32 gateway). Rollback must be performed at the release
        # level (redeploy previous release), not by toggling Verity_EMBEDDING_PROFILE.
        if embedding_profile not in ("local_siglip2", "local_openclip", PRODUCTION_EMBEDDING_PROFILE):
            raise ConfigurationError(
                f"The worker only accepts Verity_EMBEDDING_PROFILE in ('local_siglip2', 'local_openclip'). "
                "To roll back, redeploy the previous release — do not use 'legacy_api'."
            )
        embedding_provider = os.environ.get("Verity_EMBEDDING_PROVIDER", "local_siglip2" if embedding_profile == "local_siglip2" else PRODUCTION_EMBEDDING_PROVIDER).strip()
        embedding_model = os.environ.get("Verity_EMBEDDING_MODEL", "siglip2-b32-256-webli" if embedding_profile == "local_siglip2" else PRODUCTION_EMBEDDING_MODEL).strip()
        embedding_version = os.environ.get("Verity_EMBEDDING_VERSION", PRODUCTION_EMBEDDING_VERSION).strip()
        embedding_base_url = None
        embedding_input_mode = "bytes"
        expected_dim = 768 if embedding_profile == "local_siglip2" else 512

        return cls(
            worker_id=os.environ.get("Verity_WORKER_ID", socket.gethostname()).strip()[:120] or socket.gethostname(),
            poll_seconds=_optional_positive_int("Verity_WORKER_POLL_SECONDS", 3, 1, 60),
            scene_duplicate_threshold=_optional_float("Verity_SCENE_DUPLICATE_THRESHOLD", 0.92, 0.5, 0.999),
            phash_max_distance=_optional_positive_int("Verity_PHASH_MAX_DISTANCE", 12, 0, 32),
            embedding_profile=embedding_profile,
            embedding_provider=embedding_provider,
            embedding_base_url=embedding_base_url,
            embedding_api_key="",
            embedding_model=embedding_model,
            embedding_version=embedding_version,
            embedding_dimension=_optional_positive_int("Verity_EMBEDDING_DIMENSION", expected_dim, 512, 768),
            embedding_input_mode=embedding_input_mode,
            vision_base_url=None,
            vision_api_key=None,
            vision_model=None,
            vision_detail="high",
            vision_max_tokens=900,
            vision_system_prompt="",
            r2_endpoint=_optional_https_url("R2_ENDPOINT"),
            r2_access_key_id=os.environ.get("R2_ACCESS_KEY_ID", "").strip() or None,
            r2_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY", "").strip() or None,
            r2_bucket=os.environ.get("R2_BUCKET", "").strip() or None,
            r2_region=os.environ.get("R2_REGION", "auto").strip() or "auto",
            r2_public_base_url=_optional_https_url("R2_PUBLIC_BASE_URL"),
            database_url=database_url,
            db_min_connections=db_min_connections,
            db_max_connections=db_max_connections,
            db_connect_timeout=db_connect_timeout,
        )

    @property
    def vision_is_configured(self) -> bool:
        return bool(self.vision_base_url and self.vision_api_key and self.vision_model)

    @property
    def r2_is_configured(self) -> bool:
        return bool(
            self.r2_endpoint
            and self.r2_access_key_id
            and self.r2_secret_access_key
            and self.r2_bucket
        )

    @property
    def r2_publication_is_configured(self) -> bool:
        return self.r2_is_configured and bool(self.r2_public_base_url)

    def require_r2(self) -> None:
        if not self.r2_publication_is_configured:
            raise ConfigurationError(
                "R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_BASE_URL are required for WordPress publication"
            )
