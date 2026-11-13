from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from scripts import seed_native_references as seed


def _products_file(tmp_path: Path) -> Path:
    path = tmp_path / "products.json"
    path.write_text(
        json.dumps(
            [
                {
                    "sku": "SKU-1",
                    "name": "Ecolo SKU-1",
                    "images": [
                        {"src": "https://cdn.example/one.jpg"},
                        {"src": "https://cdn.example/two.jpg"},
                        {"src": "https://cdn.example/two.jpg"},
                    ],
                },
                {
                    "sku": "SKU-1",
                    "name": "Ecolo SKU-1",
                    "images": [{"src": "https://cdn.example/three.jpg"}],
                },
                {"sku": "SKU-2", "images": [{"src": "http://cdn.example/not-allowed.jpg"}]},
                {"sku": "SKU-3", "images": [{"src": "https://cdn.example/four.jpg"}]},
            ]
        ),
        encoding="utf-8",
    )
    return path


class SeedNativeReferencesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.source = _products_file(Path(self.tempdir.name))

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_dry_run_is_default_and_does_not_call_embedding_or_insert(self) -> None:
        gateway = MagicMock()
        gateway.shared_embedding_config.return_value = {"config": "encrypted"}
        gateway.list_existing_production_reference_pairs.return_value = {
            ("SKU-1", "https://cdn.example/one.jpg")
        }
        settings = SimpleNamespace()

        with (
            patch.object(seed.WorkerSettings, "from_environment", return_value=settings),
            patch.object(seed, "NativeGateway", return_value=gateway),
            patch.object(seed, "apply_shared_embedding_config", return_value=settings),
            patch.object(seed, "EmbeddingClient") as embedding_client,
        ):
            result = seed.main(["--source", str(self.source), "--limit-skus", "1", "--max-images", "2"])

        self.assertEqual(result, 0)
        embedding_client.assert_not_called()
        gateway.insert_catalog_reference.assert_not_called()
        gateway.close.assert_called_once()

    def test_confirm_uses_shared_production_client_and_skips_existing_pair(self) -> None:
        gateway = MagicMock()
        gateway.shared_embedding_config.return_value = {"config": "encrypted"}
        gateway.list_existing_production_reference_pairs.return_value = {
            ("SKU-1", "https://cdn.example/one.jpg")
        }
        client = MagicMock()
        client.embed_image_url.side_effect = [[0.1] * 512, [0.2] * 512]
        settings = SimpleNamespace()

        with (
            patch.object(seed.WorkerSettings, "from_environment", return_value=settings),
            patch.object(seed, "NativeGateway", return_value=gateway),
            patch.object(seed, "apply_shared_embedding_config", return_value=settings) as apply_config,
            patch.object(seed, "EmbeddingClient", return_value=client),
        ):
            result = seed.main(["--source", str(self.source), "--confirm", "--max-images", "2"])

        self.assertEqual(result, 0)
        apply_config.assert_called_once_with(settings, {"config": "encrypted"})
        self.assertEqual(client.embed_image_url.call_args_list[0].args, ("https://cdn.example/two.jpg",))
        self.assertEqual(client.embed_image_url.call_args_list[1].args, ("https://cdn.example/four.jpg",))
        self.assertEqual(gateway.insert_catalog_reference.call_count, 2)
        gateway.insert_catalog_reference.assert_any_call(
            sku="SKU-1",
            source_url="https://cdn.example/two.jpg",
            embedding=[0.1] * 512,
            is_primary=False,
        )
        gateway.insert_catalog_reference.assert_any_call(
            sku="SKU-3",
            source_url="https://cdn.example/four.jpg",
            embedding=[0.2] * 512,
            is_primary=True,
        )

    def test_insufficient_balance_aborts_instead_of_burning_the_remaining_batch(self) -> None:
        gateway = MagicMock()
        gateway.shared_embedding_config.return_value = {"config": "encrypted"}
        gateway.list_existing_production_reference_pairs.return_value = set()
        client = MagicMock()
        client.embed_image_url.side_effect = RuntimeError(
            'Embedding gateway returned HTTP 403: AUTHZ_INSUFFICIENT_BALANCE'
        )
        settings = SimpleNamespace()

        with (
            patch.object(seed.WorkerSettings, "from_environment", return_value=settings),
            patch.object(seed, "NativeGateway", return_value=gateway),
            patch.object(seed, "apply_shared_embedding_config", return_value=settings),
            patch.object(seed, "EmbeddingClient", return_value=client),
        ):
            with self.assertRaisesRegex(SystemExit, "Jina balance is insufficient"):
                seed.main(["--source", str(self.source), "--confirm", "--max-images", "1"])

        self.assertEqual(client.embed_image_url.call_count, 1)
        gateway.insert_catalog_reference.assert_not_called()

    def test_selection_merges_duplicate_skus_and_caps_images(self) -> None:
        selected = seed.select_skus(
            [
                {"sku": " A ", "images": [{"src": "https://cdn/a.jpg"}]},
                {"sku": "A", "images": [{"src": "https://cdn/b.jpg"}]},
                {"sku": "bad\nsku", "images": [{"src": "https://cdn/c.jpg"}]},
            ],
            max_images=2,
            limit_skus=0,
        )

        self.assertEqual(
            selected,
            [seed.SkuImages("A", "A", None, "machine_code", ("https://cdn/a.jpg", "https://cdn/b.jpg"))],
        )

    def test_selection_keeps_display_name_and_inferred_brand(self) -> None:
        selected = seed.select_skus(
            [
                {
                    "sku": "Deebot T30C Prime Omni",
                    "name": "Robot hút bụi lau nhà Ecolo Deebot T30C Prime Omni",
                    "images": [{"src": "https://cdn/ecolo.jpg"}],
                }
            ],
            max_images=3,
            limit_skus=0,
        )

        self.assertEqual(selected[0].sku_kind, "model_name")
        self.assertEqual(selected[0].brand, "Ecolo")
        self.assertEqual(selected[0].display_name, "Robot hút bụi lau nhà Ecolo Deebot T30C Prime Omni")
