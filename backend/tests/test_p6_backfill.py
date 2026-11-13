"""Unit and contract tests for Phase 6 Dual-Space Backfill Runner and Suite E Integrity Audit."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from scripts.backfill_dual_space import (
    DATACOMP_SPACE_ID,
    SIGLIP2_SPACE_ID,
    DualSpaceBackfillRunner,
    SuiteEAuditReport,
)


class TestDualSpaceBackfillRunner(unittest.TestCase):
    def setUp(self) -> None:
        self.mock_repo = MagicMock()
        self.mock_storage = MagicMock()
        self.mock_embed = MagicMock(return_value=[0.1] * 768)
        self.runner = DualSpaceBackfillRunner(
            repository=self.mock_repo,
            storage=self.mock_storage,
            siglip2_embed_fn=self.mock_embed,
        )

    def test_populate_missing_content_hashes_computes_sha256(self) -> None:
        self.mock_repo.fetch_all.return_value = [
            {"id": "asset-1", "storage_path": "path/to/img1.jpg"},
            {"id": "asset-2", "storage_path": "path/to/img2.jpg"},
        ]
        self.mock_storage.download_object.side_effect = [b"image_bytes_1", b"image_bytes_2"]

        count = self.runner.populate_missing_content_hashes(dry_run=False)

        self.assertEqual(count, 2)
        self.assertEqual(self.mock_storage.download_object.call_count, 2)
        self.assertEqual(self.mock_repo.fetch_one.call_count, 2)

    def test_populate_missing_content_hashes_dry_run_no_writes(self) -> None:
        self.mock_repo.fetch_all.return_value = [
            {"id": "asset-1", "storage_path": "path/to/img1.jpg"}
        ]
        count = self.runner.populate_missing_content_hashes(dry_run=True)
        self.assertEqual(count, 1)
        self.mock_storage.download_object.assert_not_called()
        self.mock_repo.fetch_one.assert_not_called()

    def test_backfill_datacomp_rollback_space_copies_assets_and_refs(self) -> None:
        self.mock_repo.fetch_one.side_effect = [
            {"count": 5},   # missing assets
            {"count": 10},  # missing refs
        ]
        mock_cursor = MagicMock()
        self.mock_repo.transaction.return_value.__enter__.return_value = mock_cursor

        result = self.runner.backfill_datacomp_rollback_space(dry_run=False)

        self.assertEqual(result["assets_copied"], 5)
        self.assertEqual(result["references_copied"], 10)
        self.assertEqual(mock_cursor.execute.call_count, 2)

    def test_backfill_siglip2_asset_space_generates_and_stores_768d(self) -> None:
        self.mock_repo.fetch_all.return_value = [
            {"id": "asset-1", "storage_path": "path/1.jpg", "content_hash": "sha1"}
        ]
        self.mock_storage.download_object.return_value = b"bytes1"
        mock_cursor = MagicMock()
        self.mock_repo.transaction.return_value.__enter__.return_value = mock_cursor

        count = self.runner.backfill_siglip2_asset_space(dry_run=False)

        self.assertEqual(count, 1)
        self.mock_embed.assert_called_once_with(b"bytes1")
        # Two statements per asset in one transaction: content_hash persistence
        # (media_assets) followed by the 768-d SigLIP2 embedding upsert.
        self.assertEqual(mock_cursor.execute.call_count, 2)
        update_call, insert_call = mock_cursor.execute.call_args_list
        self.assertIn("UPDATE public.media_assets SET content_hash", update_call[0][0])
        insert_args = insert_call[0][1]
        self.assertEqual(insert_args[0], "asset-1")
        self.assertEqual(insert_args[1], SIGLIP2_SPACE_ID)
        self.assertEqual(len(insert_args[2]), 768)

    def test_backfill_siglip2_reference_space_reuses_cached_asset_vector(self) -> None:
        self.mock_repo.fetch_all.return_value = [
            {
                "reference_id": "ref-1",
                "sku": "SKU-1",
                "source_media_asset_id": "asset-1",
                "source_url": None,
                "cached_asset_siglip2": "[0.1, 0.2, 0.3]",
                "content_hash": "sha-asset-1",
            }
        ]
        mock_cursor = MagicMock()
        self.mock_repo.transaction.return_value.__enter__.return_value = mock_cursor

        count = self.runner.backfill_siglip2_reference_space(dry_run=False)

        self.assertEqual(count, 1)
        # Verify no download or re-embed happened!
        self.mock_storage.download_object.assert_not_called()
        self.mock_embed.assert_not_called()
        mock_cursor.execute.assert_called_once()
        args = mock_cursor.execute.call_args[0][1]
        self.assertEqual(args[0], "ref-1")
        self.assertEqual(args[1], SIGLIP2_SPACE_ID)
        self.assertEqual(args[2], "[0.1, 0.2, 0.3]")


class TestSuiteEIntegrityAudit(unittest.TestCase):
    def setUp(self) -> None:
        self.mock_repo = MagicMock()
        self.runner = DualSpaceBackfillRunner(repository=self.mock_repo)

    def test_suite_e_audit_passes_clean_database(self) -> None:
        # Return 0 for all failure queries
        self.mock_repo.fetch_one.side_effect = [
            {"count": 0},  # 1. wrong asset dims
            {"count": 0},  # 2. wrong ref dims
            {"count": 0},  # 3. missing active assets
            {"count": 0},  # 4. missing shadow assets
            {"count": 0},  # 5. stale source sha
            {"count": 0},  # 6. missing datacomp refs
            {"count": 0},  # 7. missing siglip2 refs
            {"count": 0},  # 8. orphan spaces
            {"count": 0},  # 9. duplicate globals
        ]

        report = self.runner.run_suite_e_audit()

        self.assertEqual(report.status, "PASS")
        self.assertTrue(report.passed)
        self.assertEqual(len(report.failures), 0)
        self.assertEqual(len(report.checks), 9)
        self.assertTrue(all(c.passed for c in report.checks))

    def test_suite_e_audit_catches_dimension_violations(self) -> None:
        self.mock_repo.fetch_one.side_effect = [
            {"count": 3},  # 1. wrong asset dims (FAIL!)
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
        ]

        report = self.runner.run_suite_e_audit()

        self.assertEqual(report.status, "FAIL")
        self.assertFalse(report.passed)
        self.assertTrue(any("dim_enforcement_asset_embeddings" in f or "dimension" in f for f in report.failures))

    def test_suite_e_audit_catches_stale_source_sha(self) -> None:
        self.mock_repo.fetch_one.side_effect = [
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 2},  # 5. stale source sha (FAIL!)
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
        ]

        report = self.runner.run_suite_e_audit()

        self.assertEqual(report.status, "FAIL")
        self.assertFalse(report.passed)
        self.assertTrue(any("stale" in f for f in report.failures))

    def test_suite_e_audit_catches_missing_dual_space_references(self) -> None:
        self.mock_repo.fetch_one.side_effect = [
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 0},
            {"count": 1},  # 6. missing datacomp ref (FAIL!)
            {"count": 4},  # 7. missing siglip2 ref (FAIL!)
            {"count": 0},
            {"count": 0},
        ]

        report = self.runner.run_suite_e_audit()

        self.assertEqual(report.status, "FAIL")
        self.assertFalse(report.passed)
        self.assertEqual(len(report.failures), 2)


if __name__ == "__main__":
    unittest.main()