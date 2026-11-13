from __future__ import annotations

from pathlib import Path
import unittest


class UniversalCanonicalMediaMigrationTests(unittest.TestCase):
    def test_0029_is_additive_and_preserves_original_provenance(self) -> None:
        path = Path(__file__).resolve().parents[1] / "migrations" / "0029_universal_canonical_media_pipeline.sql"
        sql = path.read_text(encoding="utf-8")
        lower = sql.lower()
        self.assertIn("add column if not exists canonical_slug", lower)
        self.assertIn("publish_canonical_media", lower)
        self.assertIn("enqueue_canonical_media_publication", lower)
        self.assertNotIn("drop column", lower)
        self.assertNotIn("delete from public.media_assets", lower)
        self.assertNotIn("update public.media_assets set storage_path", lower)

    def test_job_is_versioned_and_idempotent(self) -> None:
        path = Path(__file__).resolve().parents[1] / "migrations" / "0029_universal_canonical_media_pipeline.sql"
        sql = path.read_text(encoding="utf-8")
        self.assertIn("publish_canonical_media:' || new.id::text || ':' || new.canonical_version::text", sql)
        self.assertIn("on conflict (idempotency_key) do nothing", sql.lower())


if __name__ == "__main__":
    unittest.main()
