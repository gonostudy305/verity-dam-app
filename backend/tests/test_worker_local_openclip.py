import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import numpy as np
from PIL import Image

from app.production_config import WorkerSettings
from app.native_gateway import GatewayError
from app.worker import MediaWorker


class TestWorkerLocalOpenCLIP(unittest.TestCase):
    def test_worker_persists_retryable_gateway_error_for_canonical_job(self):
        """A publication failure must update its lease instead of killing the loop."""
        worker = object.__new__(MediaWorker)
        worker.gateway = MagicMock()
        worker.gateway.claim_job.return_value = {
            "id": "job-123",
            "media_asset_id": "asset-123",
            "job_kind": "publish_canonical_media",
            "payload": {"canonical_version": 1},
        }
        worker._publish_canonical_media = MagicMock(side_effect=GatewayError("R2 unavailable"))
        worker._fail = MagicMock()

        self.assertTrue(worker.run_once())
        worker._fail.assert_called_once_with("job-123", "R2 unavailable", retryable=True)

    def test_product_intake_reference_job_proves_downloaded_source_hash(self):
        worker = object.__new__(MediaWorker)
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-123",
            "storage_path": "uploads/reference.jpg",
            "dimensions": {"mime_type": "image/jpeg"},
        }
        worker.gateway.download_object.return_value = b"immutable-reference-source"

        worker._prepare_product_intake_reference({"id": "job-123", "media_asset_id": "asset-123"})

        worker.gateway.rpc.assert_called_once_with(
            "complete_product_intake_reference",
            {
                "p_job_id": "job-123",
                "p_source_sha256": "3bcb96634d34e16ae5f24050dc50ad51be2b9be24af3128afccbbce26702006f",
            },
        )

    @patch("app.worker.OpenCLIPONNXRuntime")
    @patch("pathlib.Path.exists", return_value=True)
    def test_worker_initializes_and_uses_local_openclip(self, _mock_exists, mock_runtime_cls):
        mock_runtime = MagicMock()
        mock_runtime.space_id = "verity-openclip-b32-datacomp-256-v1"
        mock_runtime.model_sha256 = "824eb237a1b6ad7708cb0ffe8292322df2302c242180c2fb90f93a44e8b70474"
        mock_runtime.embed_image_bytes.return_value = [0.1] * 512
        mock_runtime_cls.return_value = mock_runtime

        settings = WorkerSettings(
            worker_id="test-local-worker",
            poll_seconds=3,
            scene_duplicate_threshold=0.92,
            phash_max_distance=12,
            embedding_profile="local_openclip",
            embedding_provider="local_openclip",
            embedding_base_url=None,
            embedding_api_key=None,
            embedding_model="openclip-b32-datacomp-256",
            embedding_version="v1",
            embedding_dimension=512,
            embedding_input_mode="bytes",
            vision_base_url=None,
            vision_api_key=None,
            vision_model=None,
            vision_detail="high",
            vision_max_tokens=900,
            vision_system_prompt="",
            r2_endpoint=None,
            r2_access_key_id=None,
            r2_secret_access_key=None,
            r2_bucket=None,
            r2_region="auto",
            r2_public_base_url=None,
        )

        gateway = MagicMock()
        gateway.get_media_asset.return_value = {
            "id": "asset-123",
            "storage_path": "uploads/test.jpg",
            "media_type": "image",
            "dimensions": {"mime_type": "image/jpeg"},
            "origin_info": {},
        }
        gateway.download_object.return_value = b"\xff\xd8\xff\xe0\x00\x10JFIF"
        gateway.metadata_examples.return_value = []
        gateway.taxonomy_options.return_value = []
        gateway.shared_vision_config.return_value = {}
        gateway.rpc.return_value = []

        worker = MediaWorker(settings, gateway=gateway)
        self.assertIsNotNone(worker.openclip_runtime)
        self.assertEqual(worker.openclip_runtime.space_id, "verity-openclip-b32-datacomp-256-v1")


if __name__ == "__main__":
    unittest.main()
