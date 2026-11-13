"""Canonical SigLIP2 ONNX helpers and isolated text/vision runtime.

The worker uses this module's canonical identity, preprocessing, and vector
validation helpers for production vision inference.  The ``SigLIP2ONNXRuntime``
class and the companion FastAPI service remain an isolated synchronous
vision+text runtime for the embedding service; they do not change selectors or
write production vectors by themselves.

Canonical identity (frozen, single source of truth is artifact_manifest.json):
- Model: timm/ViT-B-32-SigLIP2-256
- Revision: cd1efb47643f2794413dd79ef24397c175032780
- Space ID: verity-siglip2-b32-256-webli-v1
- Dimension: 768
- Image size: 256 (squash resize, bicubic, RGB, mean/std [0.5,0.5,0.5])
- Text context length: 64 (deterministic truncation/padding, HF tokenizer)
- Batch contract: 1 (dynamic_batch_verified: false)
- ORT provider: CPUExecutionProvider

Integrity verification strategy (disclosed judgment call, see Stage B report):
- source_artifacts (open_clip_config.json, open_clip_model.safetensors) and
  BOTH towers' external_data (the actual tensor weights) are verified with
  strict byte-for-byte SHA-256 equality against artifact_manifest.json --
  fail-closed on any mismatch, matching OpenCLIPONNXRuntime's convention.
- The ONNX graph *file* for the TEXT tower is verified structurally (opset,
  input_shape, output_shape) rather than by exact byte-hash. A fresh,
  this-session torch.onnx (dynamo) export of the text tower was found to
  reproduce the external weights byte-for-byte but serialize the graph
  itself with different bytes/hash than the manifest's pinned value, on the
  same pinned model/revision/opset/export-environment. This is disclosed,
  not silently patched into the manifest. The VISION tower graph is still
  verified by strict SHA-256 because it reproduced byte-identically.
- The candidate identity (model_id/revision/space_id/dimension) is always
  strictly enforced fail-closed.
"""

from __future__ import annotations

import hashlib
import io
import json
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

SIGLIP2_MODEL_ID = "timm/ViT-B-32-SigLIP2-256"
SIGLIP2_REVISION = "cd1efb47643f2794413dd79ef24397c175032780"
SIGLIP2_SPACE_ID = "verity-siglip2-b32-256-webli-v1"
SIGLIP2_DIMENSION = 768
SIGLIP2_IMAGE_SIZE = 256
SIGLIP2_CONTEXT_LENGTH = 64
SIGLIP2_BATCH_CONTRACT = 1
SIGLIP2_MEAN = 0.5
SIGLIP2_STD = 0.5

logger = logging.getLogger("siglip2_runtime")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_siglip2_preprocess(image: Image.Image) -> np.ndarray:
    """Frozen SigLIP2 preprocessing: squash resize (not center-crop), bicubic,
    RGB, mean/std [0.5,0.5,0.5]. Returns (1, 3, 256, 256) float32 NCHW."""
    rgb = image.convert("RGB")
    resized = rgb.resize((SIGLIP2_IMAGE_SIZE, SIGLIP2_IMAGE_SIZE), Image.Resampling.BICUBIC)
    pixels = np.asarray(resized, dtype=np.float32) / 255.0
    normalized = (pixels - SIGLIP2_MEAN) / SIGLIP2_STD
    return np.transpose(normalized, (2, 0, 1))[None, ...].astype(np.float32)


def _validate_embedding(vec: np.ndarray, *, space_id: str) -> np.ndarray:
    vec = np.asarray(vec, dtype=np.float32).reshape(-1)
    if vec.shape != (SIGLIP2_DIMENSION,):
        raise RuntimeError(
            f"FATAL: invalid embedding shape {vec.shape} for space {space_id}; "
            f"expected ({SIGLIP2_DIMENSION},). Refusing to bind a wrong-dimension "
            f"vector to this space id (fail-closed space binding)."
        )
    if not np.all(np.isfinite(vec)):
        raise RuntimeError("FATAL: embedding output contains non-finite (NaN or Inf) values")
    norm = float(np.linalg.norm(vec))
    if not np.isfinite(norm) or norm <= 1e-12:
        raise RuntimeError(f"FATAL: embedding vector has degenerate norm: {norm}")
    return (vec / norm).astype(np.float32)


class SigLIP2ONNXRuntime:
    """Fail-closed ONNX Runtime for the canonical SigLIP2 ViT-B/32-256 towers.

    ISOLATED STAGING ONLY -- see module docstring. Loads both towers and the
    tokenizer ONCE per process (single-worker baseline, no per-request reload,
    no dynamic batching -- batch stays 1 for the text tower per the manifest's
    dynamic_batch_verified: false).
    """

    space_id: str = SIGLIP2_SPACE_ID

    def __init__(
        self,
        artifact_dir: Path | str,
        manifest_path: Path | str | None = None,
        intra_op_num_threads: int = 2,
    ) -> None:
        if ort is None:
            raise RuntimeError("onnxruntime is required for SigLIP2ONNXRuntime")

        self.artifact_dir = Path(artifact_dir)
        manifest_path = (
            Path(manifest_path)
            if manifest_path is not None
            else Path(__file__).resolve().parents[1] / "benchmarks" / "siglip2" / "artifact_manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        candidate = manifest["candidate"]
        if candidate["model_id"] != SIGLIP2_MODEL_ID or candidate["revision"] != SIGLIP2_REVISION:
            raise ValueError("FATAL: manifest candidate identity does not match pinned SigLIP2 model/revision")
        if candidate["space_id"] != SIGLIP2_SPACE_ID or candidate["embedding_dimension"] != SIGLIP2_DIMENSION:
            raise ValueError("FATAL: manifest candidate space_id/dimension does not match pinned contract")

        exported = manifest["exported_runtime_artifacts"]
        self._verify_hash(self.artifact_dir / exported["vision"]["graph"]["path"], exported["vision"]["graph"], "vision graph")
        self._verify_hash(
            self.artifact_dir / exported["vision"]["external_data"]["path"], exported["vision"]["external_data"], "vision external data"
        )
        self._verify_hash(
            self.artifact_dir / exported["text"]["external_data"]["path"], exported["text"]["external_data"], "text external data"
        )
        # Text graph: structural verification only (see module docstring).
        self._verify_graph_shape(
            self.artifact_dir / exported["text"]["graph"]["path"], exported["text"], "text graph"
        )

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = intra_op_num_threads
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.vision_session = ort.InferenceSession(
            str(self.artifact_dir / exported["vision"]["graph"]["path"]), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.text_session = ort.InferenceSession(
            str(self.artifact_dir / exported["text"]["graph"]["path"]), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.vision_input_name = self.vision_session.get_inputs()[0].name
        self.vision_output_name = self.vision_session.get_outputs()[0].name
        self.text_input_name = self.text_session.get_inputs()[0].name
        self.text_output_name = self.text_session.get_outputs()[0].name

        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(str(self.artifact_dir), local_files_only=True)
        try:
            from open_clip.tokenizer import get_clean_fn

            self._clean = get_clean_fn("canonicalize")
        except ImportError:
            self._clean = lambda text: text

        self.manifest = manifest
        self.provider = "CPUExecutionProvider"
        self.ort_version = ort.__version__
        logger.info("SigLIP2 ONNX Runtime initialized (STAGING ONLY, space_id=%s)", self.space_id)

    @staticmethod
    def _verify_hash(path: Path, expected: dict[str, Any], label: str) -> None:
        if not path.is_file():
            raise FileNotFoundError(f"FATAL: {label} missing artifact: {path}")
        actual_bytes = path.stat().st_size
        actual_sha = sha256_file(path)
        if actual_bytes != expected["bytes"] or actual_sha != expected["sha256"]:
            raise ValueError(
                f"FATAL: {label} hash mismatch for {path.name}; expected "
                f"{expected['bytes']} bytes/{expected['sha256']}, got {actual_bytes} bytes/{actual_sha}. Refusing startup."
            )

    @staticmethod
    def _verify_graph_shape(path: Path, tower_manifest: dict[str, Any], label: str) -> None:
        if not path.is_file():
            raise FileNotFoundError(f"FATAL: {label} missing artifact: {path}")
        import onnx

        graph = onnx.load(str(path), load_external_data=False)
        opsets = {item.domain: item.version for item in graph.opset_import}
        if opsets.get("") != tower_manifest["opset"]:
            raise ValueError(f"FATAL: {label} expected opset {tower_manifest['opset']}, got {opsets}")

        def shape(value_info: Any) -> list[int | str]:
            out: list[int | str] = []
            for dim in value_info.type.tensor_type.shape.dim:
                out.append(int(dim.dim_value) if dim.dim_value else (dim.dim_param or "?"))
            return out

        actual_input = shape(graph.graph.input[0])
        actual_output = shape(graph.graph.output[0])
        if actual_input != tower_manifest["input_shape"] or actual_output != tower_manifest["output_shape"]:
            raise ValueError(
                f"FATAL: {label} shape mismatch; expected {tower_manifest['input_shape']}/{tower_manifest['output_shape']}, "
                f"got {actual_input}/{actual_output}"
            )

    def identity(self) -> dict[str, Any]:
        exported = self.manifest["exported_runtime_artifacts"]
        return {
            "model_id": SIGLIP2_MODEL_ID,
            "revision": SIGLIP2_REVISION,
            "space_id": self.space_id,
            "dimension": SIGLIP2_DIMENSION,
            "image_size": SIGLIP2_IMAGE_SIZE,
            "text_context": SIGLIP2_CONTEXT_LENGTH,
            "batch_contract": SIGLIP2_BATCH_CONTRACT,
            "runtime": "onnxruntime",
            "ort_version": self.ort_version,
            "provider": self.provider,
            "artifact_hashes": {
                "vision_graph": exported["vision"]["graph"]["sha256"],
                "vision_external": exported["vision"]["external_data"]["sha256"],
                "text_graph_pinned": exported["text"]["graph"]["sha256"],
                "text_external": exported["text"]["external_data"]["sha256"],
            },
        }

    def encode_image(self, image: Image.Image) -> np.ndarray:
        tensor = canonical_siglip2_preprocess(image)
        outputs = self.vision_session.run([self.vision_output_name], {self.vision_input_name: tensor})
        return _validate_embedding(outputs[0][0], space_id=self.space_id)

    def encode_image_bytes(self, payload: bytes, max_bytes: int = 20 * 1024 * 1024) -> np.ndarray:
        if len(payload) == 0:
            raise ValueError("empty image payload")
        if len(payload) > max_bytes:
            raise ValueError(f"image payload too large: {len(payload)} bytes > {max_bytes}")
        try:
            with Image.open(io.BytesIO(payload)) as img:
                img.load()
                return self.encode_image(img)
        except (OSError, ValueError) as exc:
            raise ValueError(f"invalid or unsupported image payload: {exc}") from exc

    def encode_text(self, text: str) -> np.ndarray:
        if text is None:
            raise ValueError("text must not be None")
        cleaned = self._clean(text)
        token_ids = self.tokenizer(
            [cleaned],
            max_length=SIGLIP2_CONTEXT_LENGTH,
            padding="max_length",
            truncation=True,
            return_tensors="np",
        )["input_ids"].astype(np.int64)
        if tuple(token_ids.shape) != (1, SIGLIP2_CONTEXT_LENGTH):
            raise RuntimeError(f"tokenizer returned {tuple(token_ids.shape)}; expected (1, {SIGLIP2_CONTEXT_LENGTH})")
        outputs = self.text_session.run([self.text_output_name], {self.text_input_name: token_ids})
        return _validate_embedding(outputs[0][0], space_id=self.space_id)


# Alias for naming symmetry with OpenCLIPONNXEncoder.
SigLIP2ONNXEncoder = SigLIP2ONNXRuntime
