"""Embed ad-hoc MCP query images in the selected production vector space.

The MCP server must never generate a vector in one space and compare it in
another.  This module therefore resolves the encoder from the explicit
``space_id`` supplied by the caller and fails closed when the pinned local
artifact is unavailable.  No query image bytes leave the MCP process.
"""

from __future__ import annotations

import io
import threading
from pathlib import Path
from typing import Any

from PIL import Image

from app.openclip_runtime import OpenCLIPONNXRuntime
from app.production_config import ConfigurationError
from app.siglip2_runtime import (
    SIGLIP2_SPACE_ID,
    _validate_embedding,
    canonical_siglip2_preprocess,
)


class EmbeddingApiError(RuntimeError):
    """Raised when a local query image cannot produce a valid vector."""


DATACOMP_SPACE_ID = "verity-openclip-b32-datacomp-256-v1"

_LOCK = threading.Lock()
_SIGLIP2_SESSION: tuple[str, Any, str, str] | None = None
_OPENCLIP_RUNTIME: tuple[str, OpenCLIPONNXRuntime] | None = None


def embed_image_bytes(
    payload: bytes,
    *,
    space_id: str,
    siglip2_model_path: str | None,
    openclip_model_path: str | None,
) -> list[float]:
    """Return a normalized image vector bound to ``space_id``.

    Only the two migration-defined spaces are supported.  Artifact loading is
    lazy and cached per process so ordinary metadata tools do not pay model
    memory cost, while repeated visual searches do not reload ONNX weights.
    """

    if not isinstance(payload, bytes) or not payload:
        raise EmbeddingApiError("Cannot embed an empty image")
    if space_id == SIGLIP2_SPACE_ID:
        return _embed_siglip2(payload, siglip2_model_path)
    if space_id == DATACOMP_SPACE_ID:
        return _embed_openclip(payload, openclip_model_path)
    raise ConfigurationError(f"No MCP image encoder is registered for embedding space {space_id!r}")


def _embed_siglip2(payload: bytes, model_path: str | None) -> list[float]:
    if not model_path:
        raise ConfigurationError("Verity_SIGLIP2_VISION_MODEL_PATH is required for fresh image search")
    path = Path(model_path)
    if not path.is_file():
        raise ConfigurationError(f"Pinned SigLIP2 vision artifact was not found at {path}")

    global _SIGLIP2_SESSION
    with _LOCK:
        if _SIGLIP2_SESSION is None or _SIGLIP2_SESSION[0] != str(path):
            try:
                import onnxruntime as ort

                options = ort.SessionOptions()
                options.intra_op_num_threads = 2
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                session = ort.InferenceSession(
                    str(path), sess_options=options, providers=["CPUExecutionProvider"]
                )
                _SIGLIP2_SESSION = (
                    str(path),
                    session,
                    session.get_inputs()[0].name,
                    session.get_outputs()[0].name,
                )
            except Exception as error:  # dependency/artifact/runtime failure
                raise ConfigurationError(f"SigLIP2 vision runtime could not start: {error}") from error
        _, session, input_name, output_name = _SIGLIP2_SESSION

    try:
        with Image.open(io.BytesIO(payload)) as image:
            tensor = canonical_siglip2_preprocess(image)
        output = session.run([output_name], {input_name: tensor})
        return _validate_embedding(output[0][0], space_id=SIGLIP2_SPACE_ID).tolist()
    except (OSError, ValueError) as error:
        raise EmbeddingApiError(f"Image could not be embedded in {SIGLIP2_SPACE_ID}: {error}") from error
    except RuntimeError as error:
        raise EmbeddingApiError(str(error)) from error


def _embed_openclip(payload: bytes, model_path: str | None) -> list[float]:
    if not model_path:
        raise ConfigurationError("Verity_OPENCLIP_MODEL_PATH is required while DataComp is active")
    path = Path(model_path)
    if not path.is_file():
        raise ConfigurationError(f"Pinned DataComp vision artifact was not found at {path}")

    global _OPENCLIP_RUNTIME
    with _LOCK:
        if _OPENCLIP_RUNTIME is None or _OPENCLIP_RUNTIME[0] != str(path):
            try:
                runtime = OpenCLIPONNXRuntime(path)
            except Exception as error:
                raise ConfigurationError(f"DataComp vision runtime could not start: {error}") from error
            if runtime.space_id != DATACOMP_SPACE_ID:
                raise ConfigurationError(
                    f"DataComp artifact resolved to unexpected space {runtime.space_id!r}"
                )
            _OPENCLIP_RUNTIME = (str(path), runtime)
        runtime = _OPENCLIP_RUNTIME[1]

    try:
        return runtime.embed_image_bytes(payload)
    except (OSError, ValueError, RuntimeError) as error:
        raise EmbeddingApiError(f"Image could not be embedded in {DATACOMP_SPACE_ID}: {error}") from error


__all__ = [
    "ConfigurationError",
    "DATACOMP_SPACE_ID",
    "EmbeddingApiError",
    "embed_image_bytes",
]
