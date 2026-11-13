import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from verity_dam_mcp.embedding import (
    ConfigurationError,
    DATACOMP_SPACE_ID,
    EmbeddingApiError,
    embed_image_bytes,
)
from app.siglip2_runtime import SIGLIP2_SPACE_ID


class EmbedImageBytesTests(unittest.TestCase):
    """Test space-bound MCP embedding dispatch and validation."""

    def test_rejects_empty_payload(self):
        with self.assertRaises(EmbeddingApiError):
            embed_image_bytes(
                b"",
                space_id=SIGLIP2_SPACE_ID,
                siglip2_model_path="dummy",
                openclip_model_path="dummy",
            )

    def test_rejects_unregistered_space(self):
        with self.assertRaises(ConfigurationError):
            embed_image_bytes(
                b"non-empty",
                space_id="unregistered-space",
                siglip2_model_path="dummy",
                openclip_model_path="dummy",
            )

    def test_requires_siglip2_model_path_when_siglip2_space(self):
        with self.assertRaises(ConfigurationError):
            embed_image_bytes(
                b"non-empty",
                space_id=SIGLIP2_SPACE_ID,
                siglip2_model_path=None,
                openclip_model_path="dummy",
            )

    def test_requires_openclip_model_path_when_datacomp_space(self):
        with self.assertRaises(ConfigurationError):
            embed_image_bytes(
                b"non-empty",
                space_id=DATACOMP_SPACE_ID,
                siglip2_model_path="dummy",
                openclip_model_path=None,
            )


if __name__ == "__main__":
    unittest.main()
