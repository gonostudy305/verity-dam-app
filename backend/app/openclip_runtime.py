"""Canonical OpenCLIP ONNX Runtime for VerityDAM.

Unified execution engine for:
1. Production Media Worker (app/worker.py)
2. Shadow Worker (app/shadow_worker.py)
3. Benchmark Validation & Curation Scripts

Strict Invariants:
- Space ID: 'verity-openclip-b32-datacomp-256-v1'
- Model SHA-256: '824eb237a1b6ad7708cb0ffe8292322df2302c242180c2fb90f93a44e8b70474'
- Preprocessing: Aspect-ratio-preserving resize (shortest side=256) followed by canonical 256x256 center crop.
- Output: 512-dimensional finite, non-zero, unit-normalized float32 vector.
- Startup: Fail-closed on missing file or SHA-256 binary mismatch.
- Output Validation: Fail-closed on invalid dimension, NaN/Inf, or degenerate norm.
"""

from __future__ import annotations

import hashlib
import io
import logging
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    import onnxruntime as ort
except ImportError:
    ort = None

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

from app.canonical_preprocessing import canonical_openclip_preprocess

CANONICAL_SPACE_ID = "verity-openclip-b32-datacomp-256-v1"
EXPECTED_MODEL_SHA256 = "824eb237a1b6ad7708cb0ffe8292322df2302c242180c2fb90f93a44e8b70474"
EMBEDDING_DIMENSION = 512

logger = logging.getLogger("openclip_runtime")


def compute_file_sha256(file_path: Path | str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


class OpenCLIPONNXRuntime:
    """Canonical fail-closed ONNX runtime for OpenCLIP ViT-B/32 DataComp."""

    def __init__(
        self,
        onnx_path: Path | str,
        expected_sha: str = EXPECTED_MODEL_SHA256,
        intra_op_num_threads: int = 2,
    ):
        if ort is None:
            raise RuntimeError("onnxruntime is required for OpenCLIPONNXRuntime")

        path_obj = Path(onnx_path)
        if not path_obj.exists():
            raise FileNotFoundError(f"OpenCLIP ONNX model not found at: {path_obj}")

        # Startup SHA-256 Binary Integrity Verification (Fail-Closed)
        actual_sha = compute_file_sha256(path_obj)
        logger.info(f"Verifying OpenCLIP ONNX artifact: {path_obj} (SHA-256: {actual_sha})")
        if actual_sha != expected_sha:
            raise ValueError(
                f"FATAL: Model artifact SHA-256 mismatch! Expected '{expected_sha}', got '{actual_sha}'. Refusing startup."
            )
        self.model_sha256 = actual_sha
        self.space_id = CANONICAL_SPACE_ID

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = intra_op_num_threads
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(path_obj), sess_options=opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        logger.info("OpenCLIP ONNX Runtime session initialized successfully.")

    def encode_image(self, image: Image.Image) -> np.ndarray:
        """Embed a PIL Image using canonical 256x256 resize + center crop preprocessing."""
        tensor = canonical_openclip_preprocess(image)
        outputs = self.session.run([self.output_name], {self.input_name: tensor})
        vec = outputs[0][0].astype(np.float32)

        # Fail-closed output integrity checks (matching API encoder standard)
        if vec.shape != (EMBEDDING_DIMENSION,):
            raise RuntimeError(
                f"FATAL: Invalid embedding output shape {vec.shape}, expected ({EMBEDDING_DIMENSION},)"
            )

        if not np.all(np.isfinite(vec)):
            raise RuntimeError("FATAL: Embedding output contains non-finite (NaN or Inf) values")

        norm = float(np.linalg.norm(vec))
        if not np.isfinite(norm) or norm <= 1e-12:
            raise RuntimeError(f"FATAL: Embedding vector has degenerate norm: {norm}")

        vec = vec / norm
        return vec

    def encode_bytes(self, payload: bytes) -> np.ndarray:
        """Embed raw image bytes without intermediate disk write."""
        with Image.open(io.BytesIO(payload)) as img:
            return self.encode_image(img)

    def embed_image_bytes(self, payload: bytes) -> list[float]:
        """Convenience method returning a python list of floats for pgvector/JSON."""
        return self.encode_bytes(payload).tolist()


# Alias for backward-compatibility during staged migration
OpenCLIPONNXEncoder = OpenCLIPONNXRuntime
