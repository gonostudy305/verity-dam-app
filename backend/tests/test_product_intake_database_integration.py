"""PostgreSQL integration checks for the product-intake database boundary.

The test is deliberately transaction-scoped: it creates no durable product or
asset data. It runs automatically once a test/staging database has migration
0037; a developer machine without that database reports a normal skip.
"""

from __future__ import annotations

import os
import unittest
import uuid

import psycopg2
from dotenv import load_dotenv


_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_ROOT, ".env"))


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url or not url.startswith("postgres"):
        raise unittest.SkipTest("DATABASE_URL is required for product-intake database integration checks.")
    return url


class TestProductIntakeDatabaseBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            connection = psycopg2.connect(_database_url(), connect_timeout=10)
            with connection.cursor() as cursor:
                cursor.execute("select to_regclass('public.product_intakes')")
                has_intakes = cursor.fetchone()[0] is not None
                cursor.execute("select to_regprocedure('public.guard_open_product_intake_asset()')")
                has_guard = cursor.fetchone()[0] is not None
            connection.close()
            if not has_intakes or not has_guard:
                raise unittest.SkipTest("Migration 0037 is not applied to this database.")
        except unittest.SkipTest:
            raise
        except Exception as error:  # noqa: BLE001
            raise unittest.SkipTest(f"Product-intake database unavailable: {error}") from error

    def setUp(self) -> None:
        self.connection = psycopg2.connect(_database_url(), connect_timeout=10)
        self.connection.autocommit = False
        self.owner_id = str(uuid.uuid4())
        self.asset_id = str(uuid.uuid4())
        self.intake_id = str(uuid.uuid4())
        with self.connection.cursor() as cursor:
            cursor.execute(
                "insert into public.media_assets (id, title, created_by, ingest_status) values (%s, 'intake test asset', %s, 'ready')",
                (self.asset_id, self.owner_id),
            )
            cursor.execute(
                """
                insert into public.product_intakes
                  (id, owner_id, proposed_name, proposed_brand, status)
                values (%s, %s, 'Intake test product', 'Verity', 'draft')
                """,
                (self.intake_id, self.owner_id),
            )
            cursor.execute(
                "insert into public.product_intake_assets (intake_id, media_asset_id) values (%s, %s)",
                (self.intake_id, self.asset_id),
            )

    def tearDown(self) -> None:
        self.connection.rollback()
        self.connection.close()

    def test_open_intake_blocks_legacy_identity_or_review_changes(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute("savepoint direct_legacy_update")
            with self.assertRaises(psycopg2.Error) as raised:
                cursor.execute(
                    "update public.media_assets set sku = 'AUTO-SKU', review_state = 'approved' where id = %s",
                    (self.asset_id,),
                )
            self.assertIn("PRODUCT_INTAKE_REVIEW_REQUIRED", str(raised.exception))
            cursor.execute("rollback to savepoint direct_legacy_update")

            cursor.execute("select set_config('verity.product_intake_approval', 'true', true)")
            cursor.execute("select set_config('verity.sync_actor', 'human', true)")
            cursor.execute(
                "update public.media_assets set sku = 'HUMAN-SKU', review_state = 'approved' where id = %s",
                (self.asset_id,),
            )
            cursor.execute("select sku, review_state from public.media_assets where id = %s", (self.asset_id,))
            self.assertEqual(cursor.fetchone(), ("HUMAN-SKU", "approved"))

    def test_migration_records_supplement_lineage_and_reference_job_kind(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                select exists (
                  select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'product_intakes'
                    and column_name = 'supplement_of_intake_id'
                )
                """
            )
            self.assertTrue(cursor.fetchone()[0])
            cursor.execute(
                """
                select exists (
                  select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'sku_references'
                    and column_name = 'image_category'
                )
                """
            )
            self.assertTrue(cursor.fetchone()[0])
            cursor.execute(
                """
                insert into public.media_ingest_jobs
                  (media_asset_id, job_kind, idempotency_key, payload)
                values (%s, 'prepare_reference', %s, jsonb_build_object('product_intake_id', %s::text))
                returning status
                """,
                (self.asset_id, f"product-intake-integration:{self.asset_id}", self.intake_id),
            )
            self.assertEqual(cursor.fetchone()[0], "queued")
