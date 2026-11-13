import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.production_config import WorkerSettings
from app.worker import MediaWorker, enrich_catalog_identity


def make_settings() -> WorkerSettings:
    return WorkerSettings(
        worker_id="test",
        poll_seconds=3,
        scene_duplicate_threshold=0.92,
        phash_max_distance=12,
        embedding_profile="production_api",
        embedding_provider="jina_9router",
        embedding_base_url="https://api.example.com/v1",
        embedding_api_key="router_test_key",
        embedding_model="jina-ai/jina-clip-v2",
        embedding_version="jina-clip-v2-v1",
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
        database_url="postgresql://verity:password@postgres/verity_media",
    )


def rpc_dispatcher(calls: list[tuple[str, dict]]):
    def _rpc(name: str, payload: dict):
        calls.append((name, payload))
        if name == "match_sku_reference_candidates":
            return []
        if name in ("match_phash_duplicate_candidates", "match_scene_duplicate_candidates"):
            return []
        if name in ("complete_media_analysis", "complete_video_analysis", "complete_wordpress_publish"):
            return None
        raise AssertionError(f"Unexpected RPC call: {name}")

    return _rpc


class AnalyzeImageDimensionsTests(unittest.TestCase):
    """Regression for audit C-04: image_features() measures the real
    width/height, but the worker used to bind them to `_width, _height` and
    never send them anywhere, so complete_media_analysis() (and therefore
    media_assets.dimensions) stayed {width: 0, height: 0, ...} forever.
    """

    def test_complete_media_analysis_receives_the_measured_dimensions(self):
        worker = MediaWorker(make_settings(), gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-1",
            "media_type": "photo",
            "storage_path": "user-1/photo.jpg",
            "dimensions": {},
        }
        worker.gateway.download_object.return_value = b"fake-source-bytes"
        worker.gateway.metadata_examples.return_value = []
        worker.gateway.shared_embedding_config.return_value = {}
        worker.gateway.shared_vision_config.return_value = {}

        rpc_calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = rpc_dispatcher(rpc_calls)

        job = {"id": "job-1", "media_asset_id": "asset-1"}

        with patch("app.worker.image_features", return_value=("a" * 16, [0.0] * 512, 1920, 1080)), \
             patch("app.worker.vision_rendition", return_value=(b"vision-bytes", "image/jpeg")), \
             patch("app.worker.call_vision_metadata", return_value={}), \
             patch("app.worker.apply_shared_embedding_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.apply_shared_vision_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.EmbeddingClient"):
            worker._analyze_image(job)

        completion_calls = [payload for name, payload in rpc_calls if name == "complete_media_analysis"]
        self.assertEqual(len(completion_calls), 1)
        self.assertEqual(completion_calls[0]["p_width"], 1920)
        self.assertEqual(completion_calls[0]["p_height"], 1080)

    def test_heic_image_generates_and_uploads_jpeg_thumbnail(self):
        worker = MediaWorker(make_settings(), gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-heic-1",
            "media_type": "photo",
            "storage_path": "user-1/sample.heic",
            "dimensions": {},
        }
        worker.gateway.download_object.return_value = b"fake-heic-bytes"
        worker.gateway.metadata_examples.return_value = []
        worker.gateway.shared_embedding_config.return_value = {}
        worker.gateway.shared_vision_config.return_value = {}

        rpc_calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = rpc_dispatcher(rpc_calls)

        job = {"id": "job-heic-1", "media_asset_id": "asset-heic-1"}

        with patch("app.worker.image_features", return_value=("a" * 16, [0.0] * 512, 4032, 3024)), \
             patch("app.worker.vision_rendition", return_value=(b"vision-bytes", "image/jpeg")), \
             patch("app.worker.wordpress_rendition", return_value=(b"jpeg-thumb-bytes", 2048, 1536, "image/jpeg")), \
             patch("app.worker.R2Publisher") as mock_publisher_cls, \
             patch("app.worker.call_vision_metadata", return_value={}), \
             patch("app.worker.apply_shared_embedding_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.apply_shared_vision_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.EmbeddingClient"):
            mock_pub = MagicMock()
            mock_pub.publish.return_value = "https://assets.verity.internal/user-1/thumb-asset-heic-1.jpg"
            mock_publisher_cls.return_value = mock_pub

            worker._analyze_image(job)

            mock_pub.publish.assert_called_once_with(
                "user-1/thumb-asset-heic-1.jpg", b"jpeg-thumb-bytes", "image/jpeg"
            )

        completion_calls = [payload for name, payload in rpc_calls if name == "complete_media_analysis"]
        self.assertEqual(len(completion_calls), 1)
        self.assertEqual(completion_calls[0]["p_thumbnail_path"], "user-1/thumb-asset-heic-1.jpg")
        self.assertEqual(completion_calls[0]["p_thumbnail_url"], "https://assets.verity.internal/user-1/thumb-asset-heic-1.jpg")


class CatalogIdentityEnrichmentTests(unittest.TestCase):
    def test_catalog_brand_fills_blank_vision_brand(self):
        metadata = {}
        sku_match = {}

        enrich_catalog_identity(
            metadata,
            sku_match,
            {
                "brand": "Ecolo",
                "model_name": "Deebot T30C Prime Omni",
                "display_name": "Robot hút bụi lau nhà Ecolo Deebot T30C Prime Omni",
            },
        )

        self.assertEqual(metadata["brand"], "Ecolo")
        self.assertEqual(metadata["brand_confidence"], 0.95)
        self.assertEqual(sku_match["catalog_identity"]["model_name"], "Deebot T30C Prime Omni")

    def test_catalog_does_not_overwrite_explicit_vision_brand(self):
        metadata = {"brand": "Rover", "brand_confidence": 0.88}
        sku_match = {}

        enrich_catalog_identity(metadata, sku_match, {"brand": "Ecolo"})

        self.assertEqual(metadata["brand"], "Rover")
        self.assertEqual(metadata["brand_confidence"], 0.88)


class BatchContextHintTests(unittest.TestCase):
    """Regression: UploadView.tsx's "Ngữ cảnh chung cho cả lô" chip is written
    to media_assets.origin_info.batch_context (see
    src/app/api/uploads/complete/route.ts), but the worker fetched the full
    asset row and never read that key back out -- call_vision_metadata() had
    no parameter for it at all, so the UI's claim that this "helps AI tag
    more accurately" was not backed by any code.
    """

    def _run(self, origin_info):
        worker = MediaWorker(make_settings(), gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-1",
            "media_type": "photo",
            "storage_path": "user-1/photo.jpg",
            "dimensions": {},
            "origin_info": origin_info,
        }
        worker.gateway.download_object.return_value = b"fake-source-bytes"
        worker.gateway.metadata_examples.return_value = []
        worker.gateway.shared_embedding_config.return_value = {}
        worker.gateway.shared_vision_config.return_value = {}
        worker.gateway.rpc.side_effect = rpc_dispatcher([])

        job = {"id": "job-1", "media_asset_id": "asset-1"}
        with patch("app.worker.image_features", return_value=("a" * 16, [0.0] * 512, 1920, 1080)), \
             patch("app.worker.vision_rendition", return_value=(b"vision-bytes", "image/jpeg")), \
             patch("app.worker.call_vision_metadata", return_value={}) as mock_call, \
             patch("app.worker.apply_shared_embedding_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.apply_shared_vision_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.EmbeddingClient"):
            worker._analyze_image(job)
        return mock_call

    def test_passes_the_batch_context_from_origin_info_to_vision_metadata(self):
        mock_call = self._run({"source": "Upload", "batch_context": "Cả lô là ảnh showroom"})
        self.assertEqual(mock_call.call_args.kwargs["batch_context"], "Cả lô là ảnh showroom")

    def test_missing_origin_info_passes_none_instead_of_crashing(self):
        mock_call = self._run(None)
        self.assertIsNone(mock_call.call_args.kwargs["batch_context"])

    def test_non_string_batch_context_passes_none(self):
        mock_call = self._run({"batch_context": 42})
        self.assertIsNone(mock_call.call_args.kwargs["batch_context"])


class NativeUrlModeEmbeddingTests(unittest.TestCase):
    """Regression for the 2026-08-25 upload-pipeline outage: 9Router's Jina
    CLIP v2 adapter rejects base64 `bytes` multimodal input outright (HTTP
    422 "Validation errors in 7 fields"), and apply_shared_embedding_config()
    always forces embedding_input_mode="url" for production jobs. Before this
    fix, the worker only presigned a download URL when
    native workers must presign the R2 object before calling embed_image_url().
    """

    def test_url_mode_presigns_and_calls_embed_image_url(self):
        worker = MediaWorker(make_settings(), gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-1",
            "media_type": "photo",
            "storage_path": "user-1/photo.jpg",
            "dimensions": {},
        }
        worker.gateway.download_object.return_value = b"fake-source-bytes"
        worker.gateway.metadata_examples.return_value = []
        worker.gateway.shared_embedding_config.return_value = {}
        worker.gateway.shared_vision_config.return_value = {}
        signed_url = "https://assets.verity.internal/user-1/photo.jpg?signature=test"
        worker.gateway.presign_download_url.return_value = signed_url

        rpc_calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = rpc_dispatcher(rpc_calls)

        job = {"id": "job-1", "media_asset_id": "asset-1"}

        embedding_client = MagicMock()
        embedding_client.embed_image_url.return_value = [0.0] * 512

        def fake_image_features(_path, embedder):
            vector = embedder(b"ignored-bytes", "image/jpeg")
            return "a" * 16, vector, 1920, 1080

        with patch("app.worker.image_features", side_effect=fake_image_features), \
             patch("app.worker.vision_rendition", return_value=(b"vision-bytes", "image/jpeg")), \
             patch("app.worker.call_vision_metadata", return_value={}), \
             patch(
                 "app.worker.apply_shared_embedding_config",
                 side_effect=lambda settings, _config: replace(settings, embedding_input_mode="url"),
             ), \
             patch("app.worker.apply_shared_vision_config", side_effect=lambda settings, _config: settings), \
             patch("app.worker.EmbeddingClient", return_value=embedding_client):
            worker._analyze_image(job)

        worker.gateway.presign_download_url.assert_called_once_with("user-1/photo.jpg", expires_in=900)
        embedding_client.embed_image_url.assert_called_once_with(signed_url)
        embedding_client.embed_image.assert_not_called()


class AnalyzeVideoTests(unittest.TestCase):
    def test_video_analysis_delegates_to_video_pipeline_and_completes(self):
        worker = MediaWorker(make_settings(), gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-video-1",
            "media_type": "video",
            "storage_path": "user-1/sample.mp4",
            "dimensions": {},
        }
        worker.gateway.download_object.return_value = b"fake-video-bytes"

        rpc_calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = rpc_dispatcher(rpc_calls)

        job = {"id": "job-vid-1", "media_asset_id": "asset-video-1"}

        with patch("app.video_processing.is_ffmpeg_available", return_value=True), \
             patch("app.video_processing.probe_video_metadata", return_value={"width": 1920, "height": 1080, "duration": "00:45"}), \
             patch("app.video_processing.extract_video_thumbnail", return_value=b"fake-thumb-jpg"):
            worker._analyze_image(job)

        video_completion_calls = [payload for name, payload in rpc_calls if name == "complete_video_analysis"]
        self.assertEqual(len(video_completion_calls), 1)
        call = video_completion_calls[0]
        self.assertEqual(call["p_width"], 1920)
        self.assertEqual(call["p_height"], 1080)
        self.assertEqual(call["p_duration"], "00:45")
        self.assertIsNone(call["p_metadata_error"])

    def test_video_publishing_uses_complete_wordpress_publish(self):
        worker = MediaWorker(make_settings(), gateway=MagicMock())
        worker.gateway = MagicMock()
        worker.gateway.get_media_asset.return_value = {
            "id": "asset-video-1",
            "media_type": "video",
            "storage_path": "user-1/sample.mp4",
            "file_url": "https://assets.verity.internal/user-1/sample.mp4",
            "dimensions": {"width": 1920, "height": 1080},
        }
        worker.gateway.download_object.return_value = b"fake-video-bytes"

        rpc_calls: list[tuple[str, dict]] = []
        worker.gateway.rpc.side_effect = rpc_dispatcher(rpc_calls)

        job = {"id": "job-pub-1", "media_asset_id": "asset-video-1"}
        worker._publish_wordpress(job)

        pub_calls = [payload for name, payload in rpc_calls if name == "complete_wordpress_publish"]
        self.assertEqual(len(pub_calls), 1)
        self.assertEqual(pub_calls[0]["p_cdn_url"], "https://assets.verity.internal/user-1/sample.mp4")
        self.assertEqual(pub_calls[0]["p_width"], 1920)
        self.assertEqual(pub_calls[0]["p_height"], 1080)


if __name__ == "__main__":
    unittest.main()
