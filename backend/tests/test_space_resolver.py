"""Unit tests for SpaceResolver and EmbeddingRegistry (Phase 5B)."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from app.space_resolver import (
    DEFAULT_ACTIVE_SPACE_ID,
    EmbeddingRegistry,
    ModelCapability,
    SpaceResolver,
)


class EmbeddingRegistryTests(unittest.TestCase):
    def test_register_and_resolve_runtime(self) -> None:
        registry = EmbeddingRegistry()
        mock_runtime = MagicMock()
        mock_runtime.space_id = "test-space"
        mock_runtime.dimension = 768

        registry.register(ModelCapability.VISION_EMBED, "test-space", mock_runtime)
        self.assertTrue(registry.has_capability(ModelCapability.VISION_EMBED, "test-space"))
        self.assertFalse(registry.has_capability(ModelCapability.TEXT_EMBED, "test-space"))
        self.assertEqual(registry.resolve(ModelCapability.VISION_EMBED, "test-space"), mock_runtime)

    def test_duplicate_registration_raises_error(self) -> None:
        registry = EmbeddingRegistry()
        mock_runtime = MagicMock()
        registry.register(ModelCapability.VISION_EMBED, "test-space", mock_runtime)

        with self.assertRaises(ValueError):
            registry.register(ModelCapability.VISION_EMBED, "test-space", mock_runtime)

    def test_unregistered_resolution_raises_key_error(self) -> None:
        registry = EmbeddingRegistry()
        with self.assertRaises(KeyError):
            registry.resolve(ModelCapability.TEXT_EMBED, "unknown-space")


class SpaceResolverTests(unittest.TestCase):
    def test_offline_defaults_when_repository_is_none(self) -> None:
        resolver = SpaceResolver(repository=None)
        self.assertEqual(resolver.get_active_space_id(), DEFAULT_ACTIVE_SPACE_ID)
        self.assertIsNone(resolver.get_nl_search_space_id())
        write_spaces = resolver.resolve_representation_write_spaces()
        self.assertEqual(write_spaces, ["verity-siglip2-b32-256-webli-v1"])

    def test_reads_runtime_state_from_mock_repository(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_one.return_value = ("verity-siglip2-b32-256-webli-v1", "verity-siglip2-b32-256-webli-v1")

        resolver = SpaceResolver(repository=mock_repo)
        self.assertEqual(resolver.get_active_space_id(), "verity-siglip2-b32-256-webli-v1")
        self.assertEqual(resolver.get_nl_search_space_id(), "verity-siglip2-b32-256-webli-v1")

    def test_reads_write_spaces_from_mock_repository(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_all.return_value = [
            ("verity-openclip-b32-datacomp-256-v1",),
            ("verity-siglip2-b32-256-webli-v1",),
        ]

        resolver = SpaceResolver(repository=mock_repo)
        spaces = resolver.resolve_representation_write_spaces()
        self.assertEqual(spaces, ["verity-openclip-b32-datacomp-256-v1", "verity-siglip2-b32-256-webli-v1"])
    def test_reads_write_spaces_from_dict_rows(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_all.return_value = [
            {"space_id": "verity-openclip-b32-datacomp-256-v1"},
            {"space_id": "verity-siglip2-b32-256-webli-v1"},
        ]

        resolver = SpaceResolver(repository=mock_repo)
        spaces = resolver.resolve_representation_write_spaces()
        self.assertEqual(spaces, ["verity-openclip-b32-datacomp-256-v1", "verity-siglip2-b32-256-webli-v1"])

    def test_reads_calibration_thresholds_from_mock_repository(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_one.return_value = (0.88, 0.68, 0.08, 0.78, 0.15, 0.86)

        resolver = SpaceResolver(repository=mock_repo)
        calib = resolver.get_space_calibration("verity-siglip2-b32-256-webli-v1")
        self.assertEqual(calib["sku_high"], 0.88)
        self.assertEqual(calib["sku_low"], 0.68)
        self.assertEqual(calib["scene_duplicate_threshold"], 0.86)

    def test_reads_calibration_thresholds_from_dict_row(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_one.return_value = {
            "sku_high": 0.91,
            "sku_low": 0.71,
            "ambiguity_margin": 0.07,
            "consistency_primary_min": 0.81,
            "consistency_spread_max": 0.14,
            "scene_duplicate_threshold": 0.93,
        }

        resolver = SpaceResolver(repository=mock_repo)
        calib = resolver.get_space_calibration("verity-siglip2-b32-256-webli-v1")
        self.assertEqual(calib["sku_high"], 0.91)
        self.assertEqual(calib["sku_low"], 0.71)
        self.assertEqual(calib["ambiguity_margin"], 0.07)
        self.assertEqual(calib["consistency_primary_min"], 0.81)
        self.assertEqual(calib["consistency_spread_max"], 0.14)
        self.assertEqual(calib["scene_duplicate_threshold"], 0.93)

    def test_calibration_falls_back_to_defaults_when_row_none_or_malformed(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_one.return_value = None

        resolver = SpaceResolver(repository=mock_repo)
        calib_none = resolver.get_space_calibration("verity-siglip2-b32-256-webli-v1")
        self.assertEqual(calib_none["sku_high"], 0.85)

        # Incomplete dict row falls back to defaults
        mock_repo.fetch_one.return_value = {"sku_high": 0.99}
        resolver2 = SpaceResolver(repository=mock_repo)
        calib_malformed = resolver2.get_space_calibration("verity-siglip2-b32-256-webli-v1")
        self.assertEqual(calib_malformed["sku_high"], 0.85)

    def test_cache_ttl_and_force_refresh(self) -> None:
        mock_repo = MagicMock()
        mock_repo.fetch_one.return_value = ("space-1", None)

        resolver = SpaceResolver(repository=mock_repo, ttl_seconds=10.0)
        self.assertEqual(resolver.get_active_space_id(), "space-1")
        self.assertEqual(mock_repo.fetch_one.call_count, 1)

        # Second call within TTL should hit cache without calling DB
        self.assertEqual(resolver.get_active_space_id(), "space-1")
        self.assertEqual(mock_repo.fetch_one.call_count, 1)

        # Force refresh bypasses cache
        mock_repo.fetch_one.return_value = ("space-2", None)
        resolver.get_runtime_state(force_refresh=True)
        self.assertEqual(resolver.get_active_space_id(), "space-2")
        self.assertEqual(mock_repo.fetch_one.call_count, 2)


if __name__ == "__main__":
    unittest.main()
