from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.production_config import (
    CANONICAL_SPACE_ID,
    PRODUCTION_EMBEDDING_DIMENSION,
    PRODUCTION_EMBEDDING_MODEL,
    PRODUCTION_EMBEDDING_PROFILE,
    PRODUCTION_EMBEDDING_PROVIDER,
    PRODUCTION_EMBEDDING_VERSION,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
MACHINE_CONFIG_FILES = (
    REPO_ROOT / ".env.example",
    REPO_ROOT / "backend" / ".env.native.example",
)

# SigLIP2 is the live production embedding tuple (see docker-compose.yml
# worker service + production_config.py). SigLIP2 ships two ONNX towers
# (vision + text) under SigLIP2-specific env keys.
CANONICAL_ENV_KEYS = {
    "profile": "VERITY_EMBEDDING_PROFILE",
    "provider": "VERITY_EMBEDDING_PROVIDER",
    "model": "VERITY_EMBEDDING_MODEL",
    "version": "VERITY_EMBEDDING_VERSION",
    "dimension": "VERITY_EMBEDDING_DIMENSION",
    "space_id": "VERITY_SIGLIP2_SPACE_ID",
    "vision_model_path": "VERITY_SIGLIP2_VISION_MODEL_PATH",
    "text_model_path": "VERITY_SIGLIP2_TEXT_MODEL_PATH",
}


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", maxsplit=1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def _parse_compose_environment(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    in_worker = False
    worker_indent = -1
    in_environment = False
    environment_indent = -1

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if line == "verity-media-worker:" or line == "verity-dam-worker:":
            in_worker = True
            worker_indent = indent
            in_environment = False
            continue
        if not in_worker:
            continue
        if indent <= worker_indent:
            in_worker = False
            in_environment = False
            continue
        if line == "environment:":
            in_environment = True
            environment_indent = indent
            continue
        if not in_environment:
            continue
        if indent <= environment_indent:
            in_environment = False
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", maxsplit=1)
        key = key.strip()
        if key not in CANONICAL_ENV_KEYS.values():
            continue
        values[key] = value.strip().strip("'\"")
    return values


def _canonical_authority() -> dict[str, str]:
    return {
        "profile": PRODUCTION_EMBEDDING_PROFILE,
        "provider": PRODUCTION_EMBEDDING_PROVIDER,
        "model": PRODUCTION_EMBEDDING_MODEL,
        "version": PRODUCTION_EMBEDDING_VERSION,
        "dimension": str(PRODUCTION_EMBEDDING_DIMENSION),
        "space_id": CANONICAL_SPACE_ID,
        "vision_model_path": "/app/models/siglip2-vision-opset18.onnx",
        "text_model_path": "/app/models/siglip2-text-opset18.onnx",
    }


class CanonicalEmbeddingTupleTests(unittest.TestCase):
    def test_compose_parser_is_scoped_to_worker_environment(self) -> None:
        compose = """services:
  unrelated-service:
    environment:
      VERITY_EMBEDDING_MODEL: wrong-model
  verity-dam-worker:
    environment:
      VERITY_EMBEDDING_MODEL: expected-model
"""
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "compose.yml"
            path.write_text(compose, encoding="utf-8")
            parsed = _parse_compose_environment(path)

        self.assertEqual(parsed["VERITY_EMBEDDING_MODEL"], "expected-model")

    def test_production_embedding_tuple_is_aligned_across_machine_configs(self) -> None:
        authority = _canonical_authority()

        for path in MACHINE_CONFIG_FILES:
            parsed = (
                _parse_compose_environment(path)
                if "compose" in path.name
                else _parse_env_file(path)
            )
            actual = {field: parsed.get(env_key) for field, env_key in CANONICAL_ENV_KEYS.items()}
            self.assertEqual(actual, authority, f"{path} drifted from production_config.py")

    def test_machine_configs_do_not_advertise_disabled_embedding_provider(self) -> None:
        forbidden_tokens = ("jina", "9router", "production_api")
        removed_legacy_keys = ("VERITY_EMBEDDING_BASE_URL", "VERITY_EMBEDDING_INPUT_MODE")

        for path in MACHINE_CONFIG_FILES:
            contents = path.read_text(encoding="utf-8").lower()
            for token in forbidden_tokens:
                self.assertNotIn(token, contents, f"{path} still contains disabled token {token!r}")
            for key in removed_legacy_keys:
                self.assertNotIn(key.lower(), contents, f"{path} still advertises ignored key {key!r}")
