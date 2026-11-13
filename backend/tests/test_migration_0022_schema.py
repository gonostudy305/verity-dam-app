"""Contract and static verification tests for Migration 0022 (Phase 5A Additive Schema).

Validates the DDL structure, cryptographic pins, triggers, conditional unique indices,
and non-destructive invariants required by:
plans/2026-08-28-siglip2-versioned-space-migration/phase-05a-additive-schema.md
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from scripts.apply_native_migrations import _migration_bytes


class Migration0022SchemaContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo_root = Path(__file__).resolve().parent.parent.parent
        self.migration_file = self.repo_root / "backend" / "migrations" / "0022_siglip2_versioned_space_schema.sql"
        self.assertTrue(self.migration_file.exists(), "Migration 0022 file must exist")
        self.sql = self.migration_file.read_text(encoding="utf-8")

    def test_canonical_lf_normalization(self) -> None:
        """Asserts file can be read and normalized to canonical LF without corruption."""
        raw_bytes = self.migration_file.read_bytes()
        lf_bytes = _migration_bytes(self.migration_file)
        self.assertTrue(len(lf_bytes) > 0)
        self.assertNotIn(b"\r\n", lf_bytes)

    def test_non_destructive_invariants(self) -> None:
        """Asserts migration 0022 NEVER drops legacy tables or columns."""
        sql_upper = self.sql.upper()
        self.assertNotIn("DROP TABLE", sql_upper)
        self.assertNotIn("DROP COLUMN", sql_upper)
        self.assertNotIn("ALTER TABLE PUBLIC.MEDIA_ASSETS DROP", sql_upper)
        self.assertNotIn("ALTER TABLE PUBLIC.SKU_REFERENCE_EMBEDDINGS DROP", sql_upper)

    def test_required_additive_tables_created(self) -> None:
        """Asserts all 6 Phase 5A tables are created with IF NOT EXISTS."""
        expected_tables = [
            "public.embedding_spaces",
            "public.embedding_runtime_state",
            "public.asset_embeddings",
            "public.sku_references",
            "public.reference_embeddings",
            "public.embedding_space_calibration",
        ]
        for table in expected_tables:
            pattern = rf"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+{re.escape(table)}"
            self.assertRegex(self.sql, re.compile(pattern, re.IGNORECASE), f"Missing table creation: {table}")

    def test_embedding_spaces_schema_and_seeds(self) -> None:
        """Asserts embedding_spaces schema, single-active index, and initial seed rows."""
        self.assertIn("uq_embedding_spaces_single_active", self.sql)
        self.assertIn("verity-openclip-b32-datacomp-256-v1", self.sql)
        self.assertIn("824eb237a1b6ad7708cb0ffe8292322df2302c242180c2fb90f93a44e8b70474", self.sql)
        self.assertIn("verity-siglip2-b32-256-webli-v1", self.sql)
        self.assertIn("7df69b5ab53b6ce7c403ad74eae6500e868614e98a8043ade2bfc452c5db92d4", self.sql)
        self.assertIn("adcae27298c2c29987daea9cb6123baff2085545afc761702e3ee3f0521257b6", self.sql)
        self.assertIn("0f278a1fe8928a571a95cdb4335afc1396c5cd935eff24a530b24c8fa2026633", self.sql)

    def test_runtime_state_singleton_and_seed(self) -> None:
        """Asserts singleton constraint (singleton_id = 1) and initial DataComp pointer."""
        self.assertIn("singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1)", self.sql)
        self.assertIn("active_space_id TEXT NOT NULL REFERENCES public.embedding_spaces(space_id)", self.sql)
        self.assertIn("nl_search_space_id TEXT NULL REFERENCES public.embedding_spaces(space_id)", self.sql)
        self.assertIn("VALUES (\n    1,\n    'verity-openclip-b32-datacomp-256-v1',\n    NULL,", self.sql)

    def test_asset_embeddings_conditional_unique_indices(self) -> None:
        """Asserts partial unique: 1 global per asset/space and deterministic crop uniqueness."""
        self.assertIn("uq_asset_embeddings_global", self.sql)
        self.assertIn("WHERE kind = 'global'", self.sql)
        self.assertIn("uq_asset_embeddings_region", self.sql)
        self.assertIn("WHERE region_id IS NOT NULL", self.sql)

    def test_reference_generalization_and_copyout(self) -> None:
        """Asserts sku_references copy-out from sku_reference_embeddings preserves business truth."""
        self.assertIn("FROM public.sku_reference_embeddings", self.sql)
        self.assertIn("ON CONFLICT (reference_id) DO NOTHING", self.sql)
        self.assertIn("uq_reference_embeddings_ref_space UNIQUE (reference_id, space_id)", self.sql)

    def test_embedding_space_calibration_seeded(self) -> None:
        """Asserts calibration table seeds DataComp and SigLIP2 calibrated thresholds."""
        self.assertIn("public.embedding_space_calibration", self.sql)
        # DataComp baseline
        self.assertIn("0.90", self.sql)
        self.assertIn("0.70", self.sql)
        self.assertIn("0.92", self.sql)
        # SigLIP2 candidate
        self.assertIn("0.85", self.sql)
        self.assertIn("0.65", self.sql)

    def test_triggers_and_security_definer_function(self) -> None:
        """Asserts triggers for dimension enforcement, immutability, invariants, and transition procedure."""
        self.assertIn("trg_enforce_asset_embedding_dimension", self.sql)
        self.assertIn("trg_enforce_reference_embedding_dimension", self.sql)
        self.assertIn("trg_protect_space_immutability", self.sql)
        self.assertIn("trg_check_embedding_runtime_state_invariants", self.sql)
        self.assertIn("public.transition_runtime_spaces", self.sql)
        self.assertIn("SECURITY DEFINER", self.sql)
        self.assertIn("REVOKE ALL ON FUNCTION public.transition_runtime_spaces(TEXT, TEXT) FROM PUBLIC", self.sql)

    def test_dimension_trigger_enforces_zero_vector_rejection(self) -> None:
        """Asserts dimension triggers explicitly reject zero vectors via vector_norm or l2_norm."""
        self.assertTrue(
            "vector_norm(NEW.vector) = 0" in self.sql or "l2_norm(NEW.vector) = 0" in self.sql,
            "Expected vector_norm or l2_norm check in 0022 schema",
        )
        self.assertIn("zero-vector is degenerate and forbidden", self.sql)

    def test_immutability_trigger_protects_all_required_columns(self) -> None:
        """Asserts immutability trigger protects dimensions, metrics, and artifact hashes."""
        columns_to_check = [
            "OLD.space_id <> NEW.space_id",
            "OLD.dimension <> NEW.dimension",
            "OLD.distance_metric <> NEW.distance_metric",
            "OLD.model_family <> NEW.model_family",
            "OLD.model_name <> NEW.model_name",
            "OLD.vision_artifact_sha256 IS DISTINCT FROM NEW.vision_artifact_sha256",
            "OLD.text_artifact_sha256 IS DISTINCT FROM NEW.text_artifact_sha256",
            "OLD.tokenizer_snapshot_sha256 IS DISTINCT FROM NEW.tokenizer_snapshot_sha256",
            "OLD.preprocess_spec_sha256 IS DISTINCT FROM NEW.preprocess_spec_sha256",
        ]
        for col in columns_to_check:
            self.assertIn(col, self.sql, f"Missing immutability check for: {col}")

    def test_transition_function_locks_singleton_and_updates_status(self) -> None:
        """Asserts transition procedure acquires row-lock and performs atomic transition."""
        self.assertIn("WHERE singleton_id = 1\n    FOR UPDATE", self.sql)
        self.assertIn("SET status = 'DEPRECATED'", self.sql)
        self.assertIn("SET status = 'ACTIVE'", self.sql)
        self.assertIn("SET active_space_id = new_recognition_space_id", self.sql)

    def test_frozen_legacy_tables_remain_unmodified(self) -> None:
        """Asserts sku_reference_embeddings and media_assets legacy columns are untouched."""
        self.assertNotIn("ALTER TABLE public.sku_reference_embeddings_shadow", self.sql)
        self.assertNotIn("DROP TABLE IF EXISTS public.sku_reference_embeddings", self.sql)
        self.assertNotIn("ALTER TABLE public.media_assets ALTER COLUMN image_embedding", self.sql)


if __name__ == "__main__":
    unittest.main()
