"""
Local SigLIP2 Vision Embedder with Hard Gate Fail-Closed Provenance Verification.
Enforces exact byte-level SHA-256 match against artifact_manifest.json,
canonical 256x256 squash preprocessing, and strict 768-dim output contract.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

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

logger = logging.getLogger("local_embedder")

# Paths
PROJECT_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = PROJECT_ROOT / "backend" / "benchmarks" / "siglip2" / "artifact_manifest.json"
DEFAULT_MODELS_DIR = PROJECT_ROOT / "backend" / "benchmarks" / "models"

# Constants
SIGLIP2_SPACE_ID = "verity-siglip2-b32-256-webli-v1"
SIGLIP2_DIMENSION = 768
SIGLIP2_IMAGE_SIZE = 256
SIGLIP2_MEAN = 0.5
SIGLIP2_STD = 0.5


def sha256_file(path: Path) -> str:
    """Compute SHA-256 of file in 1MB chunks."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest().lower()


def canonical_siglip2_preprocess(image: Image.Image) -> np.ndarray:
    """
    Frozen SigLIP2 vision preprocessing:
    Squash resize to 256x256 (BICUBIC, no center crop), RGB, mean/std [0.5, 0.5, 0.5].
    Returns (1, 3, 256, 256) float32 NCHW.
    """
    rgb = image.convert("RGB")
    resized = rgb.resize((SIGLIP2_IMAGE_SIZE, SIGLIP2_IMAGE_SIZE), Image.Resampling.BICUBIC)
    pixels = np.asarray(resized, dtype=np.float32) / 255.0
    normalized = (pixels - SIGLIP2_MEAN) / SIGLIP2_STD
    return np.transpose(normalized, (2, 0, 1))[None, ...].astype(np.float32)


def validate_embedding(vec: np.ndarray) -> np.ndarray:
    """
    Strict output validation:
    - Must be 1-D array
    - Must have dimension == 768 (NO OTHER DIMENSION ACCEPTED)
    - All values must be finite
    - L2 norm must be approximately 1.0 (un-normalized raw features normalized to 1.0)
    """
    if vec.ndim > 1:
        vec = vec.squeeze()
    if vec.shape != (SIGLIP2_DIMENSION,):
        raise ValueError(
            f"[HARD GATE] Embedding dimension mismatch: expected ({SIGLIP2_DIMENSION},), got {vec.shape}"
        )
    if not np.all(np.isfinite(vec)):
        raise ValueError("[HARD GATE] Embedding contains non-finite values (NaN/Inf)")

    norm = float(np.linalg.norm(vec))
    if norm < 1e-6:
        raise ValueError("[HARD GATE] Embedding vector norm is zero or degenerate")

    return vec / norm


class LocalSigLIP2Embedder:
    """
    Local SigLIP2 Vision ONNX Runtime with Hard Gate Fail-Closed Verification.
    """

    def __init__(self, models_dir: Path = DEFAULT_MODELS_DIR):
        if ort is None:
            raise ImportError("onnxruntime is not installed. Please install onnxruntime.")

        self.models_dir = Path(models_dir)
        self.graph_path = self.models_dir / "siglip2-vision-opset18.onnx"
        self.data_path = self.models_dir / "siglip2-vision-opset18.onnx.data"

        # 1. HARD GATE: Verify against artifact_manifest.json
        self._verify_hard_gate()

        # 2. Initialize ONNX Runtime session
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        self.session = ort.InferenceSession(
            str(self.graph_path),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

        print(
            f"[LocalEmbedder] Hard Gate PASS. Initialized Canonical SigLIP2 Vision ONNX (dim={SIGLIP2_DIMENSION}, space={SIGLIP2_SPACE_ID})"
        )

    def _verify_hard_gate(self) -> None:
        """Verify model files exist and match exact SHA-256 pinned in artifact_manifest.json."""
        if not MANIFEST_PATH.exists():
            raise FileNotFoundError(f"[HARD GATE] artifact_manifest.json not found at {MANIFEST_PATH}")

        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        v_spec = manifest["exported_runtime_artifacts"]["vision"]
        expected_graph_sha256 = v_spec["graph"]["sha256"].lower()
        expected_data_sha256 = v_spec["external_data"]["sha256"].lower()
        expected_dim = manifest["candidate"]["embedding_dimension"]

        if expected_dim != SIGLIP2_DIMENSION:
            raise RuntimeError(
                f"[HARD GATE] Manifest dimension mismatch: expected {SIGLIP2_DIMENSION}, found {expected_dim}"
            )

        if not self.graph_path.exists():
            raise FileNotFoundError(f"[HARD GATE] Vision graph ONNX missing at: {self.graph_path}")
        if not self.data_path.exists():
            raise FileNotFoundError(f"[HARD GATE] Vision data ONNX missing at: {self.data_path}")

        # Compute hashes
        graph_sha = sha256_file(self.graph_path)
        if graph_sha != expected_graph_sha256:
            raise RuntimeError(
                f"[HARD GATE FAILED] Vision ONNX graph SHA-256 mismatch!\n"
                f"  Expected: {expected_graph_sha256}\n"
                f"  Actual:   {graph_sha}"
            )

        data_sha = sha256_file(self.data_path)
        if data_sha != expected_data_sha256:
            raise RuntimeError(
                f"[HARD GATE FAILED] Vision ONNX weights SHA-256 mismatch!\n"
                f"  Expected: {expected_data_sha256}\n"
                f"  Actual:   {data_sha}"
            )

        self.vision_graph_sha256 = graph_sha
        self.external_data_sha256 = data_sha

    def embed_image(self, image: Image.Image) -> List[float]:
        """
        Preprocess image and return normalized 768-dim embedding as list of floats.
        """
        tensor = canonical_siglip2_preprocess(image)
        raw_output = self.session.run([self.output_name], {self.input_name: tensor})[0]
        normalized = validate_embedding(raw_output[0])
        return [float(x) for x in normalized]

    def get_provenance_assertion(self) -> Dict[str, Any]:
        """Return provenance bundle required by extended _finalize."""
        return {
            "space_id": SIGLIP2_SPACE_ID,
            "embedding_dimension": SIGLIP2_DIMENSION,
            "vision_artifact_sha256": self.vision_graph_sha256,
            "external_sha256": self.external_data_sha256,
        }


if __name__ == "__main__":
    print("[test] Testing LocalSigLIP2Embedder Hard Gate & Inference...")
    embedder = LocalSigLIP2Embedder()
    test_img = Image.new("RGB", (640, 480), color=(100, 150, 200))
    vec = embedder.embed_image(test_img)
    print(f"[test] Output vector length: {len(vec)}")
    print(f"[test] Vector sample (first 5): {vec[:5]}")
    norm = float(np.linalg.norm(np.array(vec)))
    print(f"[test] Vector L2 norm: {norm:.6f}")
    assert len(vec) == 768, f"Dimension must be 768, got {len(vec)}"
    assert abs(norm - 1.0) < 1e-4, f"Norm must be 1.0, got {norm}"
    print("[test] SUCCESS! Local embedder passed all Hard Gate checks.")
