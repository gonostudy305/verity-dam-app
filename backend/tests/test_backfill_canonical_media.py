from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.backfill_canonical_media import CanonicalMediaBackfill


class CanonicalMediaBackfillTests(unittest.TestCase):
    def test_queue_missing_is_dry_run_by_default(self) -> None:
        repo = MagicMock()
        repo.fetch_all.return_value = [{"id": "asset-1", "canonical_version": 2}]
        runner = CanonicalMediaBackfill(repo)

        self.assertEqual(runner.queue_missing(dry_run=True), {"candidates": 1, "queued": 0})
        repo.transaction.assert_not_called()

    def test_queue_missing_uses_versioned_idempotency_key(self) -> None:
        cursor = MagicMock()
        cursor.rowcount = 1
        repo = MagicMock()
        repo.fetch_all.return_value = [{"id": "asset-1", "canonical_version": 3}]

        @contextmanager
        def transaction():
            yield cursor

        repo.transaction.side_effect = transaction
        runner = CanonicalMediaBackfill(repo)

        self.assertEqual(runner.queue_missing(dry_run=False), {"candidates": 1, "queued": 1})
        params = cursor.execute.call_args.args[1]
        self.assertEqual(params[1], "publish_canonical_media:asset-1:3")
        self.assertEqual(params[2], 3)

    def test_audit_passes_only_when_every_ready_image_has_verified_canonical_url(self) -> None:
        repo = MagicMock()
        repo.fetch_one.side_effect = [
            {"total_eligible": 130, "canonical_ready": 130, "pending": 0, "invalid_canonical_urls": 0},
            {"count": 0},
        ]
        report = CanonicalMediaBackfill(repo).audit()
        self.assertTrue(report.passed)
        self.assertEqual(report.status, "PASS")


if __name__ == "__main__":
    unittest.main()
