import json
import unittest
from types import SimpleNamespace

from app.embedding_api import EmbeddingApiError, EmbeddingClient
from app.production_config import WorkerSettings


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.requests: list[dict] = []

    def post(self, url, **kwargs):
        self.requests.append({"url": url, **kwargs})
        return self.response


def make_settings(embedding_input_mode: str = "bytes") -> WorkerSettings:
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
        embedding_dimension=4,
        embedding_input_mode=embedding_input_mode,
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


def ok_response(vector: list[float]) -> SimpleNamespace:
    body = {"data": [{"embedding": vector}]}
    return SimpleNamespace(
        status_code=200,
        headers={},
        text=json.dumps(body),
        json=lambda: body,
    )


def one_pixel_jpeg() -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (4, 4), color=(200, 30, 30)).save(buffer, format="JPEG")
    return buffer.getvalue()


class EmbedImageRequestShapeTests(unittest.TestCase):
    """Regression for the 2026-08-25 upload-pipeline outage: 9Router's Jina
    CLIP v2 adapter validates multimodal input as
    ``input: [str | TextDoc{text} | ImageDoc{image}]``. Neither ``bytes`` nor
    ``url`` is a real field on that union -- both were rejected live with
    HTTP 422 "Validation errors in 7 fields". The only field name that a live
    call against the real gateway returned HTTP 200 for is ``image`` (and a
    bare string, while schema-valid, is scored as text and must be avoided).
    """

    def test_embed_image_sends_base64_under_the_image_field(self):
        session = FakeSession(ok_response([0.1, 0.2, 0.3, 0.4]))
        client = EmbeddingClient(make_settings(embedding_input_mode="bytes"), session=session)

        client.embed_image(one_pixel_jpeg())

        body = session.requests[0]["json"]
        self.assertEqual(list(body["input"][0].keys()), ["image"])
        self.assertIsInstance(body["input"][0]["image"], str)

    def test_embed_image_url_sends_the_url_under_the_image_field(self):
        session = FakeSession(ok_response([0.1, 0.2, 0.3, 0.4]))
        client = EmbeddingClient(make_settings(embedding_input_mode="url"), session=session)

        client.embed_image_url("https://assets.verity.internal/media/x.jpg?signature=test")

        body = session.requests[0]["json"]
        self.assertEqual(
            body["input"],
            [{"image": "https://assets.verity.internal/media/x.jpg?signature=test"}],
        )

    def test_embed_image_url_rejects_a_non_https_url(self):
        session = FakeSession(ok_response([0.1, 0.2, 0.3, 0.4]))
        client = EmbeddingClient(make_settings(embedding_input_mode="url"), session=session)

        with self.assertRaises(EmbeddingApiError):
            client.embed_image_url("http://assets.verity.internal/x.jpg")
        self.assertEqual(session.requests, [])

    def test_embed_image_rejects_bytes_when_input_mode_is_url(self):
        """Production never accepts raw bytes over the wire (see
        docs/production-media-pipeline.md): a URL-mode gateway must always
        go through embed_image_url, so embed_image has to refuse bytes
        rather than silently sending them anyway.
        """
        session = FakeSession(ok_response([0.1, 0.2, 0.3, 0.4]))
        client = EmbeddingClient(make_settings(embedding_input_mode="url"), session=session)

        with self.assertRaises(EmbeddingApiError):
            client.embed_image(one_pixel_jpeg())
        self.assertEqual(session.requests, [])


if __name__ == "__main__":
    unittest.main()
