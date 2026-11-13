import base64
import contextlib
import io
import unittest

import requests
from PIL import Image

from app.creative_worker import CreativeProviderAdapter, CreativeProviderError, CreativeWorker, CreativeWorkerSettings, ProviderCandidate


class _Response:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload


class _Session:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error

    def post(self, *args, **kwargs):
        if self.error:
            raise self.error
        return self.response


class CreativeProviderAdapterTests(unittest.TestCase):
    def setUp(self):
        self.settings = CreativeWorkerSettings("test", 1, "openai-key", "gemini-key")
        self.manifest = {"system_constraints": ["system"], "template_prompt": "template", "untrusted_article_context": {"title": "x"}}

    def test_openai_normalizes_one_base64_candidate(self):
        payload = base64.b64encode(b"webp-bytes").decode("ascii")
        adapter = CreativeProviderAdapter(self.settings, _Session(_Response(200, {"data": [{"b64_json": payload}, {"b64_json": payload}]}, {"x-request-id": "req-1"})))
        candidate = adapter.generate_candidate("openai", "gpt-image-2.5-flare-2026-09-08", self.manifest, [], 7, object(), "1024x1024")
        self.assertEqual(candidate.payload, b"webp-bytes")
        self.assertEqual(candidate.provider_request_id, "req-1")

    def test_missing_image_is_normalized_to_zero_candidates(self):
        adapter = CreativeProviderAdapter(self.settings, _Session(_Response(200, {"data": [{"text": "ignored"}]})))
        self.assertIsNone(adapter.generate_candidate("openai", "gpt-image-2.5-flare-2026-09-08", self.manifest, [], 7, object(), None))

    def test_transport_failure_is_ambiguous_and_not_retried(self):
        adapter = CreativeProviderAdapter(self.settings, _Session(error=requests.Timeout("network")))
        with self.assertRaises(CreativeProviderError) as raised:
            adapter.generate_candidate("openai", "gpt-image-2.5-flare-2026-09-08", self.manifest, [], 7, object(), None)
        self.assertEqual(raised.exception.retry_class, "ambiguous")

    def test_confirmed_rate_limit_is_safe_to_retry(self):
        adapter = CreativeProviderAdapter(self.settings, _Session(_Response(429, {})))
        with self.assertRaises(CreativeProviderError) as raised:
            adapter.generate_candidate("openai", "gpt-image-2.5-flare-2026-09-08", self.manifest, [], 7, object(), None)
        self.assertEqual(raised.exception.retry_class, "safe_retry")

    def test_reference_read_failure_is_known_no_charge(self):
        class Storage:
            def get_bytes(self, _key):
                raise OSError("R2 unavailable")

        adapter = CreativeProviderAdapter(self.settings, _Session(_Response(200, {})))
        with self.assertRaises(CreativeProviderError) as raised:
            adapter.generate_candidate(
                "openai", "gpt-image-2.5-flare-2026-09-08", self.manifest,
                [{"storage_path": "reference/real-product.png"}], 7, Storage(), None,
            )
        self.assertEqual(raised.exception.retry_class, "do_not_retry")

    def test_prompt_keeps_authoritative_brand_channel_before_untrusted_article(self):
        prompt = CreativeProviderAdapter._prompt({
            **self.manifest,
            "brand_guideline": {"primary_color": "#1557A0"},
            "channel_guideline": {"aspect_ratio": "16:9"},
        })
        self.assertIn("Approved brand guideline (authoritative)", prompt)
        self.assertIn('\"primary_color\": \"#1557A0\"', prompt)
        self.assertLess(prompt.index("Approved brand guideline"), prompt.index("Article context (untrusted)"))

    def test_terminal_safe_retry_releases_reservation_before_manual_attempt(self):
        class Cursor:
            def __init__(self):
                self.calls = []

            def execute(self, statement, params):
                self.calls.append((statement, params))

        class Repository:
            def __init__(self):
                self.cursor = Cursor()

            @contextlib.contextmanager
            def transaction(self):
                yield self.cursor

        repository = Repository()
        worker = CreativeWorker(self.settings, repository=repository, storage=object(), adapter=object())
        worker._fail(
            {"attempts": 3, "max_attempts": 3, "budget_period_id": "budget", "generation_id": "generation", "job_id": "job"},
            CreativeProviderError("provider unavailable", "safe_retry"),
        )
        self.assertTrue(any("status = 'released'" in statement for statement, _ in repository.cursor.calls))
        self.assertTrue(any("recompute_creative_slots" in statement for statement, _ in repository.cursor.calls))

    def test_non_terminal_safe_retry_stays_queued_for_derived_state(self):
        class Cursor:
            def __init__(self):
                self.calls = []

            def execute(self, statement, params):
                self.calls.append((statement, params))

        class Repository:
            def __init__(self):
                self.cursor = Cursor()

            @contextlib.contextmanager
            def transaction(self):
                yield self.cursor

        repository = Repository()
        worker = CreativeWorker(self.settings, repository=repository, storage=object(), adapter=object())
        worker._fail(
            {"attempts": 1, "max_attempts": 3, "budget_period_id": "budget", "generation_id": "generation", "job_id": "job"},
            CreativeProviderError("rate limited", "safe_retry"),
        )
        generation_update = next(
            params
            for statement, params in repository.cursor.calls
            if "update public.ai_image_generations" in statement
        )
        self.assertEqual(generation_update[0], "queued")

    def test_preserve_pixels_compositor_never_invokes_a_model_after_background(self):
        def image_bytes(color):
            buffer = io.BytesIO()
            Image.new("RGBA", (100, 100), color).save(buffer, format="PNG")
            return buffer.getvalue()

        class Storage:
            def get_bytes(self, key):
                self.last_key = key
                return image_bytes((255, 0, 0, 255))

        worker = CreativeWorker(self.settings, repository=object(), storage=Storage(), adapter=object())
        result = worker._compose_preserve_pixels(
            ProviderCandidate(image_bytes((0, 0, 255, 255)), "image/png", "req", 7),
            [{"role": "cutout", "storage_path": "verified/cutout.png", "sha256": "a" * 64}],
            {"width": 320, "height": 320, "product_box": {"left": 40, "top": 40, "width": 240, "height": 240}},
        )
        self.assertEqual(result.mime_type, "image/webp")
        self.assertEqual(result.provenance["model_calls_after_composite"], 0)

    def test_stale_promotion_saga_is_released_for_ttl_expiry(self):
        class Cursor:
            def __init__(self):
                self.calls = []

            def execute(self, statement, params=None):
                self.calls.append((statement, params))

            def fetchall(self):
                return []

        class Repository:
            def __init__(self):
                self.cursor = Cursor()

            @contextlib.contextmanager
            def transaction(self):
                yield self.cursor

        repository = Repository()
        worker = CreativeWorker(self.settings, repository=repository, storage=object(), adapter=object())
        self.assertEqual(worker.sweep_expired_candidates(), 0)
        statements = "\n".join(statement for statement, _ in repository.cursor.calls)
        self.assertIn("promotion saga exceeded candidate TTL", statements)
        self.assertIn("select output_id, temp_storage_key from public.expire_creative_candidates()", statements)


if __name__ == "__main__":
    unittest.main()
