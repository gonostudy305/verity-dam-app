"""Mission S.SIGLIP-FAST Stage B: real ONNX runtime staging tests.

Skips (does not fail) when the large pinned model snapshot / exported ONNX
artifacts are not materialized on this machine (they are not committed to
git -- ~1.9GB of weights). When present (this session's staging artifact
dir), every test runs real ONNX Runtime inference; nothing here is mocked.
"""

from __future__ import annotations

import io
import os
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ARTIFACT_DIR = Path(
    os.environ.get(
        "SIGLIP2_ARTIFACT_DIR",
        Path(__file__).resolve().parents[1] / "_artifacts" / "timm-ViT-B-32-SigLIP2-256",
    )
)
_VISION_ONNX = ARTIFACT_DIR / "siglip2-vision-opset18.onnx"
_TEXT_ONNX = ARTIFACT_DIR / "siglip2-text-opset18.onnx"
ARTIFACTS_AVAILABLE = _VISION_ONNX.is_file() and _TEXT_ONNX.is_file()


def _make_image(size: tuple[int, int], mode: str = "RGB", color=(120, 60, 200)) -> bytes:
    img = Image.new(mode, size, color if mode != "RGBA" else color + (255,))
    buf = io.BytesIO()
    fmt = "PNG" if mode == "RGBA" else "JPEG"
    img.save(buf, format=fmt)
    return buf.getvalue()


@unittest.skipUnless(ARTIFACTS_AVAILABLE, "SigLIP2 ONNX artifacts not materialized on this machine")
class TestSigLIP2RuntimeStaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from app.siglip2_runtime import SIGLIP2_DIMENSION, SigLIP2ONNXRuntime

        cls.SIGLIP2_DIMENSION = SIGLIP2_DIMENSION
        cls.runtime = SigLIP2ONNXRuntime(ARTIFACT_DIR)

    # ---- output contract ----
    def test_image_embedding_output_contract(self) -> None:
        img = Image.new("RGB", (640, 480), (10, 20, 30))
        vec = self.runtime.encode_image(img)
        self.assertEqual(vec.shape, (self.SIGLIP2_DIMENSION,))
        self.assertTrue(np.all(np.isfinite(vec)))
        self.assertAlmostEqual(float(np.linalg.norm(vec)), 1.0, places=4)

    def test_text_embedding_output_contract(self) -> None:
        vec = self.runtime.encode_text("ghế sofa da màu nâu")
        self.assertEqual(vec.shape, (self.SIGLIP2_DIMENSION,))
        self.assertTrue(np.all(np.isfinite(vec)))
        self.assertAlmostEqual(float(np.linalg.norm(vec)), 1.0, places=4)

    # ---- fail-closed space ID binding ----
    def test_embedding_dimension_is_bound_to_siglip2_space(self) -> None:
        vec = self.runtime.encode_text("test")
        self.assertEqual(vec.shape[0], 768)
        self.assertEqual(self.runtime.space_id, "verity-siglip2-b32-256-webli-v1")
        self.assertNotEqual(vec.shape[0], 512, "SigLIP2 vector must never be 512-d (DataComp dimension)")

    def test_identity_reports_canonical_space_and_never_datacomp(self) -> None:
        identity = self.runtime.identity()
        self.assertEqual(identity["space_id"], "verity-siglip2-b32-256-webli-v1")
        self.assertEqual(identity["dimension"], 768)
        self.assertNotIn("datacomp", identity["space_id"].lower())
        self.assertNotIn("openclip", identity["space_id"].lower())

    # ---- error paths: image ----
    def test_rejects_empty_image_payload(self) -> None:
        with self.assertRaises(ValueError):
            self.runtime.encode_image_bytes(b"")

    def test_rejects_oversized_image_payload(self) -> None:
        oversized = b"\x00" * (25 * 1024 * 1024)
        with self.assertRaises(ValueError):
            self.runtime.encode_image_bytes(oversized, max_bytes=20 * 1024 * 1024)

    def test_rejects_garbage_bytes_as_image(self) -> None:
        with self.assertRaises(ValueError):
            self.runtime.encode_image_bytes(b"this is not an image, just bytes")

    def test_rejects_wrong_mime_like_payload_gracefully(self) -> None:
        # A text payload masquerading as image bytes must fail closed, not crash.
        with self.assertRaises(ValueError):
            self.runtime.encode_image_bytes(b'{"not": "an image"}')

    # ---- image contract: JPEG/PNG/portrait/landscape/RGBA ----
    def test_image_contract_jpeg_landscape(self) -> None:
        img = Image.open(io.BytesIO(_make_image((640, 480), "RGB")))
        vec = self.runtime.encode_image(img)
        self.assertEqual(vec.shape, (768,))

    def test_image_contract_jpeg_portrait(self) -> None:
        img = Image.open(io.BytesIO(_make_image((480, 640), "RGB")))
        vec = self.runtime.encode_image(img)
        self.assertEqual(vec.shape, (768,))

    def test_image_contract_png(self) -> None:
        buf = io.BytesIO()
        Image.new("RGB", (300, 300), (5, 5, 5)).save(buf, format="PNG")
        img = Image.open(io.BytesIO(buf.getvalue()))
        vec = self.runtime.encode_image(img)
        self.assertEqual(vec.shape, (768,))

    def test_image_contract_rgba_input(self) -> None:
        buf = io.BytesIO()
        Image.new("RGBA", (300, 300), (5, 5, 5, 128)).save(buf, format="PNG")
        img = Image.open(io.BytesIO(buf.getvalue()))
        vec = self.runtime.encode_image(img)  # must auto-convert to RGB internally
        self.assertEqual(vec.shape, (768,))
        self.assertTrue(np.all(np.isfinite(vec)))

    # ---- text contract ----
    def test_text_contract_vietnamese_accented(self) -> None:
        vec = self.runtime.encode_text("ảnh phòng khách hiện đại có rèm trắng")
        self.assertEqual(vec.shape, (768,))

    def test_text_contract_vietnamese_unaccented(self) -> None:
        vec = self.runtime.encode_text("anh phong khach hien dai co rem trang")
        self.assertEqual(vec.shape, (768,))

    def test_text_contract_mixed_vn_en(self) -> None:
        vec = self.runtime.encode_text("ghế sofa da color brown 3 seats")
        self.assertEqual(vec.shape, (768,))

    def test_text_contract_sku(self) -> None:
        vec = self.runtime.encode_text("SKU-ABC-1234")
        self.assertEqual(vec.shape, (768,))

    def test_text_contract_long_query_truncates_deterministically(self) -> None:
        long_text = "áo thun nam cotton form rộng " * 20
        vec1 = self.runtime.encode_text(long_text)
        vec2 = self.runtime.encode_text(long_text)
        self.assertEqual(vec1.shape, (768,))
        np.testing.assert_array_equal(vec1, vec2)  # deterministic

    def test_text_contract_empty_query_policy(self) -> None:
        # Empty query must not crash the runtime; it produces a valid (if
        # low-information) embedding -- policy for whether to call this at
        # all lives in the (not-yet-wired) search route, not this runtime.
        vec = self.runtime.encode_text("")
        self.assertEqual(vec.shape, (768,))
        self.assertTrue(np.all(np.isfinite(vec)))

    # ---- two-tower sanity (no quality claim) ----
    def test_two_tower_sanity_same_space(self) -> None:
        text_vec = self.runtime.encode_text("ghế sofa màu nâu")
        img = Image.new("RGB", (256, 256), (139, 90, 43))  # brownish
        image_vec = self.runtime.encode_image(img)
        self.assertEqual(text_vec.shape, image_vec.shape)
        cosine = float(np.dot(text_vec, image_vec))
        self.assertTrue(np.isfinite(cosine))
        self.assertGreaterEqual(cosine, -1.0001)
        self.assertLessEqual(cosine, 1.0001)
        self.assertAlmostEqual(float(np.linalg.norm(text_vec)), 1.0, places=4)
        self.assertAlmostEqual(float(np.linalg.norm(image_vec)), 1.0, places=4)


if __name__ == "__main__":
    unittest.main()
