import io
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import numpy as np
from PIL import Image

from app.canonical_preprocessing import canonical_openclip_preprocess
from app.openclip_runtime import (
    CANONICAL_SPACE_ID,
    EXPECTED_MODEL_SHA256,
    OpenCLIPONNXRuntime,
    compute_file_sha256,
)


class TestOpenCLIPRuntime(unittest.TestCase):
    def test_canonical_space_and_sha_constants(self):
        self.assertEqual(CANONICAL_SPACE_ID, "verity-openclip-b32-datacomp-256-v1")
        self.assertEqual(
            EXPECTED_MODEL_SHA256,
            "824eb237a1b6ad7708cb0ffe8292322df2302c242180c2fb90f93a44e8b70474",
        )

    def test_canonical_preprocessing_fixed_256(self):
        # Test non-square image
        img = Image.new("RGB", (800, 600), color=(128, 64, 32))
        tensor = canonical_openclip_preprocess(img)
        self.assertEqual(tensor.shape, (1, 3, 256, 256))
        self.assertEqual(tensor.dtype, np.float32)

        # Test square image
        img_sq = Image.new("RGB", (512, 512), color=(255, 255, 255))
        tensor_sq = canonical_openclip_preprocess(img_sq)
        self.assertEqual(tensor_sq.shape, (1, 3, 256, 256))

    def test_runtime_fail_closed_missing_file(self):
        with self.assertRaises(FileNotFoundError):
            OpenCLIPONNXRuntime(Path("/non/existent/model.onnx"))

    @patch("app.openclip_runtime.compute_file_sha256")
    @patch("pathlib.Path.exists", return_value=True)
    def test_runtime_fail_closed_sha_mismatch(self, _mock_exists, mock_compute_sha):
        mock_compute_sha.return_value = "invalid_sha_12345"
        with self.assertRaises(ValueError) as ctx:
            OpenCLIPONNXRuntime(Path("/dummy/model.onnx"), expected_sha=EXPECTED_MODEL_SHA256)
        self.assertIn("FATAL: Model artifact SHA-256 mismatch", str(ctx.exception))

    @patch("app.openclip_runtime.ort")
    @patch("app.openclip_runtime.compute_file_sha256")
    @patch("pathlib.Path.exists", return_value=True)
    def test_runtime_encoding_and_normalization(self, _mock_exists, mock_compute_sha, mock_ort):
        mock_compute_sha.return_value = EXPECTED_MODEL_SHA256
        
        # Mock ONNX session
        mock_session = MagicMock()
        mock_input = MagicMock()
        mock_input.name = "input_tensor"
        mock_output = MagicMock()
        mock_output.name = "output_embedding"
        mock_session.get_inputs.return_value = [mock_input]
        mock_session.get_outputs.return_value = [mock_output]
        
        # Return an unnormalized 512-d array
        raw_vec = np.ones((1, 512), dtype=np.float32) * 2.0
        mock_session.run.return_value = [raw_vec]
        mock_ort.InferenceSession.return_value = mock_session

        runtime = OpenCLIPONNXRuntime(Path("/dummy/model.onnx"))
        self.assertEqual(runtime.space_id, CANONICAL_SPACE_ID)
        self.assertEqual(runtime.model_sha256, EXPECTED_MODEL_SHA256)

        img = Image.new("RGB", (300, 300), color=(100, 150, 200))
        vec = runtime.encode_image(img)
        
        self.assertEqual(vec.shape, (512,))
        self.assertEqual(vec.dtype, np.float32)
        norm = np.linalg.norm(vec)
        self.assertAlmostEqual(norm, 1.0, places=5)

        # Test embed_image_bytes
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        vec_list = runtime.embed_image_bytes(buf.getvalue())
        self.assertIsInstance(vec_list, list)
        self.assertEqual(len(vec_list), 512)
        self.assertAlmostEqual(np.linalg.norm(vec_list), 1.0, places=5)

    @patch("app.openclip_runtime.ort")
    @patch("app.openclip_runtime.compute_file_sha256")
    @patch("pathlib.Path.exists", return_value=True)
    def test_runtime_fail_closed_invalid_dimension(self, _mock_exists, mock_compute_sha, mock_ort):
        mock_compute_sha.return_value = EXPECTED_MODEL_SHA256
        mock_session = MagicMock()
        mock_session.get_inputs.return_value = [MagicMock(name="input_tensor")]
        mock_session.get_outputs.return_value = [MagicMock(name="output_embedding")]
        # Return 384 dimensions instead of 512
        mock_session.run.return_value = [np.ones((1, 384), dtype=np.float32)]
        mock_ort.InferenceSession.return_value = mock_session

        runtime = OpenCLIPONNXRuntime(Path("/dummy/model.onnx"))
        with self.assertRaises(RuntimeError) as ctx:
            runtime.encode_image(Image.new("RGB", (100, 100)))
        self.assertIn("Invalid embedding output shape", str(ctx.exception))

    @patch("app.openclip_runtime.ort")
    @patch("app.openclip_runtime.compute_file_sha256")
    @patch("pathlib.Path.exists", return_value=True)
    def test_runtime_fail_closed_nan_or_inf(self, _mock_exists, mock_compute_sha, mock_ort):
        mock_compute_sha.return_value = EXPECTED_MODEL_SHA256
        mock_session = MagicMock()
        mock_session.get_inputs.return_value = [MagicMock(name="input_tensor")]
        mock_session.get_outputs.return_value = [MagicMock(name="output_embedding")]
        
        # NaN vector
        bad_vec = np.ones((1, 512), dtype=np.float32)
        bad_vec[0, 10] = np.nan
        mock_session.run.return_value = [bad_vec]
        mock_ort.InferenceSession.return_value = mock_session

        runtime = OpenCLIPONNXRuntime(Path("/dummy/model.onnx"))
        with self.assertRaises(RuntimeError) as ctx:
            runtime.encode_image(Image.new("RGB", (100, 100)))
        self.assertIn("non-finite", str(ctx.exception))

    @patch("app.openclip_runtime.ort")
    @patch("app.openclip_runtime.compute_file_sha256")
    @patch("pathlib.Path.exists", return_value=True)
    def test_runtime_fail_closed_zero_norm(self, _mock_exists, mock_compute_sha, mock_ort):
        mock_compute_sha.return_value = EXPECTED_MODEL_SHA256
        mock_session = MagicMock()
        mock_session.get_inputs.return_value = [MagicMock(name="input_tensor")]
        mock_session.get_outputs.return_value = [MagicMock(name="output_embedding")]
        
        # Zero vector
        mock_session.run.return_value = [np.zeros((1, 512), dtype=np.float32)]
        mock_ort.InferenceSession.return_value = mock_session

        runtime = OpenCLIPONNXRuntime(Path("/dummy/model.onnx"))
        with self.assertRaises(RuntimeError) as ctx:
            runtime.encode_image(Image.new("RGB", (100, 100)))
        self.assertIn("degenerate norm", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
