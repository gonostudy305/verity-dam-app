import os
import unittest
from unittest.mock import patch

from app.production_config import ConfigurationError, WorkerSettings


BASE_ENV = {
    "DATABASE_URL": "postgresql://verity:password@postgres/verity_media",
}


class R2ConfigurationTests(unittest.TestCase):
    def test_https_r2_urls_are_accepted(self):
        with patch.dict(
            os.environ,
            {
                **BASE_ENV,
                "R2_ENDPOINT": "https://account.r2.cloudflarestorage.com",
                "R2_PUBLIC_BASE_URL": "https://assets.verity.internal/",
            },
            clear=True,
        ):
            settings = WorkerSettings.from_environment()
        self.assertEqual(settings.r2_endpoint, "https://account.r2.cloudflarestorage.com")
        self.assertEqual(settings.r2_public_base_url, "https://assets.verity.internal")

    def test_insecure_r2_endpoint_is_rejected(self):
        with patch.dict(os.environ, {**BASE_ENV, "R2_ENDPOINT": "http://untrusted.example"}, clear=True):
            with self.assertRaises(ConfigurationError):
                WorkerSettings.from_environment()

    def test_production_embedding_defaults_are_explicit(self):
        with patch.dict(os.environ, BASE_ENV, clear=True):
            settings = WorkerSettings.from_environment()
        self.assertEqual(settings.embedding_profile, "local_siglip2")
        self.assertEqual(settings.embedding_provider, "local_siglip2")
        self.assertEqual(settings.embedding_model, "siglip2-b32-256-webli")
        self.assertEqual(settings.embedding_dimension, 768)
        self.assertEqual(settings.embedding_input_mode, "bytes")

    def test_embedding_key_is_optional_in_worker_environment(self):
        with patch.dict(os.environ, BASE_ENV, clear=True):
            settings = WorkerSettings.from_environment()
        self.assertEqual(settings.embedding_api_key, "")

    def test_embedding_key_is_never_read_from_worker_environment(self):
        with patch.dict(os.environ, {**BASE_ENV, "Verity_EMBEDDING_API_KEY": "stale_key"}, clear=True):
            settings = WorkerSettings.from_environment()
        self.assertEqual(settings.embedding_api_key, "")

    def test_unknown_profile_is_rejected_by_production_worker(self):
        with patch.dict(os.environ, {**BASE_ENV, "Verity_EMBEDDING_PROFILE": "unsupported_profile"}, clear=True):
            with self.assertRaises(ConfigurationError):
                WorkerSettings.from_environment()

    def test_legacy_api_profile_is_rejected(self):
        # legacy_api is intentionally disabled to prevent cross-space contamination.
        # Rollback is achieved by redeploying a previous release, not by toggling the profile.
        with patch.dict(os.environ, {**BASE_ENV, "Verity_EMBEDDING_PROFILE": "legacy_api"}, clear=True):
            with self.assertRaises(ConfigurationError):
                WorkerSettings.from_environment()

    def test_database_url_is_required(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ConfigurationError):
                WorkerSettings.from_environment()

    def test_invalid_embedding_dimension_is_rejected(self):
        with patch.dict(os.environ, {**BASE_ENV, "Verity_EMBEDDING_DIMENSION": "1024"}, clear=True):
            with self.assertRaises(ConfigurationError):
                WorkerSettings.from_environment()


if __name__ == "__main__":
    unittest.main()
