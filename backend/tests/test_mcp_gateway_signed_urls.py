import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from verity_dam_mcp.gateway import MediaMcpGateway
from verity_dam_mcp.formatting import format_media_asset


def make_gateway(storage: Mock) -> MediaMcpGateway:
    # __init__ opens a real PostgresRepository/R2Storage connection, which
    # this test has no business standing up -- go through __new__ instead,
    # same technique as test_mcp_gateway_finalize.py's make_gateway().
    gateway = MediaMcpGateway.__new__(MediaMcpGateway)
    gateway.storage = storage
    return gateway


class CreateSignedUrlsTests(unittest.TestCase):
    """Original keys are presigned fallbacks, never permanent agent URLs."""

    def test_uses_a_scoped_presigned_url_even_when_a_public_base_is_configured(self):
        storage = Mock()
        storage.settings = SimpleNamespace(public_base_url="https://assets.verity.internal")
        storage.presign_download.return_value = "https://account.r2.cloudflarestorage.com/bucket/key?X-Amz=1"
        gateway = make_gateway(storage)

        result = gateway.create_signed_urls(["user-1/2026/08/a.jpg"])

        self.assertEqual(result, {"user-1/2026/08/a.jpg": "https://account.r2.cloudflarestorage.com/bucket/key?X-Amz=1"})
        storage.public_url.assert_not_called()
        storage.presign_download.assert_called_once_with(
            "user-1/2026/08/a.jpg", scope_prefix="user-1", expires_in=3600
        )

    def test_falls_back_to_a_scoped_presigned_url_without_a_public_base(self):
        storage = Mock()
        storage.settings = SimpleNamespace(public_base_url=None)
        storage.presign_download.return_value = "https://account.r2.cloudflarestorage.com/bucket/key?X-Amz=1"
        gateway = make_gateway(storage)

        result = gateway.create_signed_urls(["user-1/2026/08/a.jpg"])

        self.assertEqual(result, {"user-1/2026/08/a.jpg": "https://account.r2.cloudflarestorage.com/bucket/key?X-Amz=1"})
        storage.public_url.assert_not_called()
        storage.presign_download.assert_called_once_with(
            "user-1/2026/08/a.jpg", scope_prefix="user-1", expires_in=3600
        )

    def test_a_failing_path_is_skipped_rather_than_raising(self):
        storage = Mock()
        storage.settings = SimpleNamespace(public_base_url="https://assets.verity.internal")
        storage.presign_download.side_effect = ValueError("path traversal")
        gateway = make_gateway(storage)

        self.assertEqual(gateway.create_signed_urls(["../bad"]), {})

    def test_formatter_prefers_current_canonical_url_over_signed_original(self):
        asset = format_media_asset(
            {
                "id": "asset-1",
                "title": "Verity C02",
                "storage_path": "source/original.webp",
                "cdn_key": "wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp",
                "cdn_url": "https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp",
                "canonical_slug": "verity-c02",
                "canonical_version": 2,
                "canonical_published_version": 2,
            },
            {"source/original.webp": "https://r2.invalid/signed-original"},
        )
        self.assertEqual(asset["file_url"], asset["cdn_url"])
        self.assertNotIn("signed-original", asset["file_url"])


if __name__ == "__main__":
    unittest.main()
