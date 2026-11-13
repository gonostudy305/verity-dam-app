"""Static contract checks for the additive Creative Pipeline migrations.

The full transition-table/deadlock test requires a PostgreSQL 16 integration
environment. These checks keep the authoritative SQL contract from regressing
in ordinary unit-test runs where no database is available.
"""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CORE = (ROOT / "migrations" / "0044_creative_pipeline_core.sql").read_text(encoding="utf-8")
GOVERNANCE = (ROOT / "migrations" / "0045_creative_pipeline_governance.sql").read_text(encoding="utf-8")
DERIVED_STATES = (ROOT / "migrations" / "0048_creative_derived_failure_states.sql").read_text(encoding="utf-8")
RETRY_RECOVERY = (ROOT / "migrations" / "0049_creative_retry_and_saga_recovery.sql").read_text(encoding="utf-8")


class CreativePipelineMigrationContractTest(unittest.TestCase):
    def test_core_has_library_and_ai_resolution_paths(self) -> None:
        self.assertIn("create table if not exists public.creative_slot_resolutions", CORE.lower())
        self.assertIn("source_kind in ('library', 'ai')", CORE.lower())
        self.assertIn("uq_creative_resolution_active_slot", CORE.lower())
        self.assertIn("uq_creative_request_article_revision", CORE.lower())

    def test_governance_uses_statement_transition_tables(self) -> None:
        lowered = GOVERNANCE.lower()
        self.assertIn("referencing old table as old_rows new table as new_rows", lowered)
        self.assertIn("for each statement execute function public.sync_creative_review_states", lowered)
        self.assertNotIn("after update of review_state on public.media_assets\nreferencing", lowered)

    def test_synthetic_data_has_db_backstops(self) -> None:
        lowered = GOVERNANCE.lower()
        self.assertIn("trg_guard_sku_reference_not_synthetic", lowered)
        self.assertIn("trg_guard_legacy_sku_reference_not_synthetic", lowered)
        self.assertIn("trg_guard_few_shot_example_not_synthetic", lowered)
        self.assertIn("trg_guard_creative_product_reference_not_synthetic", lowered)
        self.assertIn("synthetic_reference_migration_blocked", lowered)

    def test_terminal_generation_failure_is_not_left_as_generating(self) -> None:
        lowered = DERIVED_STATES.lower()
        self.assertIn("when exists (select 1 from public.ai_image_generations g where g.slot_id = s.id) then 'failed'", lowered)
        self.assertIn("when exists (select 1 from public.creative_slots s where s.request_id = r.id and s.status = 'failed') then 'failed'", lowered)

    def test_manual_retry_has_one_child_per_failed_generation(self) -> None:
        lowered = RETRY_RECOVERY.lower()
        self.assertIn("retry_of_generation_id uuid", lowered)
        self.assertIn("uq_ai_image_generation_retry_parent", lowered)


if __name__ == "__main__":
    unittest.main()
