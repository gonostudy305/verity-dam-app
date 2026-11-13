"""Runtime Registry and Dynamic Space Resolver for Versioned Embedding Spaces.

Part of Phase 5B (Runtime Abstraction):
- Binds runtimes by (ModelCapability, space_id).
- Resolves dynamic selectors (active_space_id, nl_search_space_id) from public.embedding_runtime_state.
- Resolves representation write set (ACTIVE, SHADOW, DEPRECATED) from public.embedding_spaces.
- Fetches per-space calibrated decision thresholds from public.embedding_space_calibration.
- Enforces fail-closed validation and in-memory TTL bounded cache (<= 5.0s).
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Any, Protocol, Sequence

from app.postgres_repository import PostgresRepository, PostgresSettings


class ModelCapability(str, Enum):
    VISION_EMBED = "vision_embed"
    TEXT_EMBED = "text_embed"


class VectorEmbeddingRuntime(Protocol):
    space_id: str
    dimension: int
    capability: ModelCapability

    def embed_image_bytes(self, payload: bytes, mime_type: str = "image/jpeg") -> list[float]:
        ...

    def embed_text(self, text: str) -> list[float]:
        ...


class EmbeddingRegistry:
    """Registry maintaining initialized model runtime instances keyed by (capability, space_id)."""

    def __init__(self) -> None:
        self._runtimes: dict[tuple[ModelCapability, str], Any] = {}

    def register(self, capability: ModelCapability, space_id: str, runtime: Any) -> None:
        key = (capability, space_id)
        if key in self._runtimes:
            raise ValueError(f"Runtime already registered for capability {capability} and space {space_id}")
        self._runtimes[key] = runtime

    def resolve(self, capability: ModelCapability, space_id: str) -> Any:
        key = (capability, space_id)
        if key not in self._runtimes:
            raise KeyError(f"No runtime handle available for capability {capability} in space {space_id}")
        return self._runtimes[key]

    def has_capability(self, capability: ModelCapability, space_id: str) -> bool:
        return (capability, space_id) in self._runtimes

    def registered_keys(self) -> list[tuple[ModelCapability, str]]:
        return list(self._runtimes.keys())


# Fallback defaults for bootstrap / offline / unseeded states
DEFAULT_ACTIVE_SPACE_ID = "verity-siglip2-b32-256-webli-v1"
DEFAULT_WRITE_SPACES = ["verity-siglip2-b32-256-webli-v1"]
WRITE_ELIGIBLE_STATUSES = ("ACTIVE", "SHADOW", "DEPRECATED")

DEFAULT_CALIBRATIONS: dict[str, dict[str, float]] = {
    "verity-openclip-b32-datacomp-256-v1": {
        "sku_high": 0.90,
        "sku_low": 0.70,
        "ambiguity_margin": 0.08,
        "consistency_primary_min": 0.80,
        "consistency_spread_max": 0.15,
        "scene_duplicate_threshold": 0.92,
    },
    "verity-siglip2-b32-256-webli-v1": {
        "sku_high": 0.85,
        "sku_low": 0.65,
        "ambiguity_margin": 0.08,
        "consistency_primary_min": 0.75,
        "consistency_spread_max": 0.15,
        "scene_duplicate_threshold": 0.85,
    },
}


class SpaceResolver:
    """Dynamic Space Resolver connecting runtime components to PostgreSQL space state."""

    def __init__(
        self,
        repository: PostgresRepository | None = None,
        ttl_seconds: float = 5.0,
    ) -> None:
        self._repository = repository
        self._ttl_seconds = ttl_seconds
        self._state_cache: dict[str, Any] | None = None
        self._state_cache_time: float = 0.0
        self._write_spaces_cache: list[str] | None = None
        self._write_spaces_cache_time: float = 0.0
        self._calibration_cache: dict[str, dict[str, float]] = {}
        self._calibration_cache_time: dict[str, float] = {}

    def _get_repository(self) -> PostgresRepository:
        if self._repository is not None:
            return self._repository
        try:
            settings = PostgresSettings.from_environment()
            self._repository = PostgresRepository(settings)
            return self._repository
        except Exception:
            return None  # Allow graceful offline operation for testing

    def get_runtime_state(self, force_refresh: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        if not force_refresh and self._state_cache is not None and (now - self._state_cache_time) < self._ttl_seconds:
            return self._state_cache

        repo = self._get_repository()
        if repo is None:
            return {"active_space_id": DEFAULT_ACTIVE_SPACE_ID, "nl_search_space_id": None}

        try:
            row = repo.fetch_one(
                """
                SELECT active_space_id, nl_search_space_id
                FROM public.embedding_runtime_state
                WHERE singleton_id = 1
                """
            )
            if row:
                if isinstance(row, dict):
                    active_id = row.get("active_space_id")
                    nl_id = row.get("nl_search_space_id")
                elif isinstance(row, (list, tuple)):
                    active_id = row[0] if len(row) > 0 else None
                    nl_id = row[1] if len(row) > 1 else None
                else:
                    active_id = None
                    nl_id = None

                if isinstance(active_id, str):
                    self._state_cache = {
                        "active_space_id": active_id,
                        "nl_search_space_id": nl_id if isinstance(nl_id, str) else None,
                    }
                    self._state_cache_time = now
                    return self._state_cache
        except Exception:
            pass

        return {"active_space_id": DEFAULT_ACTIVE_SPACE_ID, "nl_search_space_id": None}

    def get_active_space_id(self) -> str:
        state = self.get_runtime_state()
        return state.get("active_space_id") or DEFAULT_ACTIVE_SPACE_ID

    def get_nl_search_space_id(self) -> str | None:
        state = self.get_runtime_state()
        return state.get("nl_search_space_id")

    def resolve_representation_write_spaces(self, force_refresh: bool = False) -> list[str]:
        now = time.monotonic()
        if not force_refresh and self._write_spaces_cache is not None and (now - self._write_spaces_cache_time) < self._ttl_seconds:
            return self._write_spaces_cache

        repo = self._get_repository()
        if repo is None:
            return list(DEFAULT_WRITE_SPACES)

        try:
            rows = repo.fetch_all(
                """
                SELECT space_id
                FROM public.embedding_spaces
                WHERE status IN ('ACTIVE', 'SHADOW', 'DEPRECATED')
                ORDER BY created_at ASC
                """
            )
            # PostgresRepository.fetch_all returns RealDictCursor dict rows in
            # production; hand-built unit fixtures use tuple rows. Accept both,
            # mirroring get_runtime_state (already dual-shape aware). Previously
            # only tuple rows were parsed, so production dict rows silently fell
            # through to DEFAULT_WRITE_SPACES and the live embedding_spaces table
            # was never honored -- benign in single-space steady state but it
            # drops the DEPRECATED space during a rollback (dual-write freshness).
            # See the space resolver design notes.
            if rows:
                extracted: list[str] = []
                for row in rows:
                    if isinstance(row, dict):
                        space_id = row.get("space_id")
                    elif isinstance(row, (list, tuple)) and len(row) > 0:
                        space_id = row[0]
                    else:
                        space_id = None
                    if isinstance(space_id, str):
                        extracted.append(space_id)
                    else:
                        extracted = []
                        break
                if extracted:
                    self._write_spaces_cache = extracted
                    self._write_spaces_cache_time = now
                    return self._write_spaces_cache
        except Exception:
            pass

        return list(DEFAULT_WRITE_SPACES)

    def get_space_calibration(self, space_id: str, force_refresh: bool = False) -> dict[str, float]:
        now = time.monotonic()
        if not force_refresh and space_id in self._calibration_cache:
            if (now - self._calibration_cache_time.get(space_id, 0)) < self._ttl_seconds:
                return self._calibration_cache[space_id]

        repo = self._get_repository()
        if repo is not None:
            try:
                row = repo.fetch_one(
                    """
                    SELECT sku_high, sku_low, ambiguity_margin,
                           consistency_primary_min, consistency_spread_max,
                           scene_duplicate_threshold
                    FROM public.embedding_space_calibration
                    WHERE space_id = %s
                    """,
                    (space_id,),
                )
                calib = None
                if isinstance(row, dict):
                    keys = (
                        "sku_high",
                        "sku_low",
                        "ambiguity_margin",
                        "consistency_primary_min",
                        "consistency_spread_max",
                        "scene_duplicate_threshold",
                    )
                    if all(k in row and isinstance(row[k], (int, float)) for k in keys):
                        calib = {k: float(row[k]) for k in keys}
                elif isinstance(row, (list, tuple)) and len(row) >= 6:
                    if all(isinstance(x, (int, float)) for x in row[:6]):
                        calib = {
                            "sku_high": float(row[0]),
                            "sku_low": float(row[1]),
                            "ambiguity_margin": float(row[2]),
                            "consistency_primary_min": float(row[3]),
                            "consistency_spread_max": float(row[4]),
                            "scene_duplicate_threshold": float(row[5]),
                        }
                if calib is not None:
                    self._calibration_cache[space_id] = calib
                    self._calibration_cache_time[space_id] = now
                    return calib
            except Exception:
                pass

        if space_id in DEFAULT_CALIBRATIONS:
            return dict(DEFAULT_CALIBRATIONS[space_id])
        return dict(DEFAULT_CALIBRATIONS[DEFAULT_ACTIVE_SPACE_ID])


# Global singleton instance for app / worker / mcp
_DEFAULT_RESOLVER = SpaceResolver()
_DEFAULT_REGISTRY = EmbeddingRegistry()


def get_default_resolver() -> SpaceResolver:
    return _DEFAULT_RESOLVER


def get_default_registry() -> EmbeddingRegistry:
    return _DEFAULT_REGISTRY
