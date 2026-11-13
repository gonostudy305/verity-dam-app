"""Live-DB regression test for audit C-03's trigger fix
(20260826000000_fix_p0_critical_bugs.sql).

This is the one thing in the P0 fix that genuinely cannot be verified with
mocks: whether the BEFORE/AFTER INSERT trigger split on media_assets actually
behaves correctly against a real Postgres foreign key, not just what the SQL
text says it should do. It connects to DATABASE_URL, inserts real rows inside
a transaction, and always rolls back -- nothing it does is ever committed.

Skips itself (rather than failing) when those credentials are not available,
so it does not need any CI/test-DB scaffolding this repo does not have. It
also only means anything AFTER 20260826000000_fix_p0_critical_bugs.sql has
been applied to the target database -- against the pre-fix trigger, the video
case below is expected to fail (that failure is exactly the bug C-03
describes).
"""

from __future__ import annotations

import os
import unittest
import uuid

try:
    import psycopg2
except ImportError:  # pragma: no cover - psycopg2 is a tools-only dependency
    psycopg2 = None

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if load_dotenv is not None:
    load_dotenv(os.path.join(_ROOT, ".env"))

_REQUIRED_ENV = [
    "DATABASE_URL",
]


def _live_db_available() -> bool:
    return psycopg2 is not None and all(os.environ.get(key) for key in _REQUIRED_ENV)


@unittest.skipUnless(
    _live_db_available(),
    "Requires a live native PostgreSQL connection (DATABASE_URL in backend/.env) "
    "with 20260826000000_fix_p0_critical_bugs.sql already applied.",
)
class VideoAnalysisTriggerTests(unittest.TestCase):
    def setUp(self):
        self.conn = psycopg2.connect(os.environ["DATABASE_URL"])
        self.conn.autocommit = False
        self.addCleanup(self._rollback_and_close)

    def _rollback_and_close(self) -> None:
        self.conn.rollback()
        self.conn.close()

    def _insert_asset(self, media_type: str) -> tuple[str, str]:
        storage_path = f"test-p0-c03/{uuid.uuid4()}.bin"
        with self.conn.cursor() as cur:
            cur.execute(
                """
                insert into public.media_assets
                    (file_url, thumbnail_url, storage_path, thumbnail_path, media_type)
                values (%s, %s, %s, %s, %s)
                returning id::text, ingest_status
                """,
                (storage_path, storage_path, storage_path, storage_path, media_type),
            )
            asset_id, ingest_status = cur.fetchone()
        return asset_id, ingest_status

    def _analyze_job_count(self, asset_id: str) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                "select count(*) from public.media_ingest_jobs "
                "where media_asset_id = %s and job_kind = 'analyze_image'",
                (asset_id,),
            )
            (count,) = cur.fetchone()
        return count

    def test_photo_insert_still_gets_an_analysis_job(self):
        asset_id, ingest_status = self._insert_asset("photo")
        self.assertEqual(ingest_status, "queued")
        self.assertEqual(self._analyze_job_count(asset_id), 1)

    def test_video_insert_gets_no_analysis_job(self):
        # If the BEFORE INSERT trigger enqueued the job itself (the bug this
        # migration fixes), this insert would raise a foreign key violation
        # before ever reaching this assertion -- media_assets.id does not
        # exist yet at BEFORE INSERT time.
        asset_id, ingest_status = self._insert_asset("video")
        self.assertEqual(ingest_status, "ready")
        self.assertEqual(self._analyze_job_count(asset_id), 0)


if __name__ == "__main__":
    unittest.main()
