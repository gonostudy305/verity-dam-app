"""Integration tests for the native SKU -> product sync (migration 0011).

The native trigger has no external identity-provider dependency: machine-vs-human
is carried by the custom GUC ``verity.sync_actor`` that the application sets. These
tests drive that GUC directly.

Covers:
  1. machine pass creates then cleanly replaces a draft primary link
  2. human actor (verity.sync_actor='human') confirms the link, and a subsequent
     machine pass can neither override the SKU nor the confirmed link
  3. human actor re-points an already-confirmed link to a new product
  4. human actor clears the SKU -> the primary link is deleted

Skipped automatically when DATABASE_URL is unset or the native DB/A2 tables are
unavailable.
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
        if os.environ.get("Verity_NATIVE_INTEGRATION_REQUIRED") == "1":
            raise RuntimeError("DATABASE_URL (native PostgreSQL) is required for the mandatory integration gate.")
        raise unittest.SkipTest("DATABASE_URL (native PostgreSQL) is required for this integration test.")
    return url


def _connect():
    return psycopg2.connect(_database_url(), connect_timeout=10)


class TestNativeSkuProductSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            conn = _connect()
            with conn.cursor() as cur:
                cur.execute("select to_regclass('public.media_asset_products')")
                has_tables = cur.fetchone()[0] is not None
                cur.execute("select to_regprocedure('public.sync_primary_product_from_sku()')")
                has_trigger_fn = cur.fetchone()[0] is not None
            conn.close()
            if not has_tables or not has_trigger_fn:
                raise unittest.SkipTest("A2 native tables/trigger (migration 0011) not found in database.")
        except unittest.SkipTest:
            raise
        except Exception as error:  # noqa: BLE001
            if os.environ.get("Verity_NATIVE_INTEGRATION_REQUIRED") == "1":
                raise
            raise unittest.SkipTest(f"Native database unavailable for integration test: {error}")

    def setUp(self):
        self.conn = _connect()
        self.conn.autocommit = False

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def _actor(cur, actor: str) -> None:
        # SET LOCAL is transaction-scoped; the latest value wins for the rest of
        # the transaction, so tests can toggle machine/human freely.
        cur.execute("set local verity.sync_actor = %s", (actor,))

    def _primary_link(self, cur, asset_id: str):
        cur.execute(
            """
            select p.primary_sku, map.role, map.review_state, map.source
            from public.media_asset_products map
            join public.verity_products p on p.id = map.product_id
            where map.media_asset_id = %s and map.role = 'primary' and map.review_state <> 'rejected'
            """,
            (asset_id,),
        )
        return cur.fetchall()

    def test_case_1_machine_draft_replace(self):
        with self.conn.cursor() as cur:
            asset_id = str(uuid.uuid4())
            self._actor(cur, "machine")
            cur.execute(
                "insert into public.media_assets (id, sku, brand, review_state) values (%s, 'SKU-ALPHA', 'Acme', 'pending')",
                (asset_id,),
            )
            rows = self._primary_link(cur, asset_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0], ("SKU-ALPHA", "primary", "draft", "sku_embedding"))

            cur.execute("update public.media_assets set sku = 'SKU-BETA' where id = %s", (asset_id,))
            rows = self._primary_link(cur, asset_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0], ("SKU-BETA", "primary", "draft", "sku_embedding"))

    def test_case_2_human_confirm_then_machine_cannot_override(self):
        with self.conn.cursor() as cur:
            asset_id = str(uuid.uuid4())
            # Machine draft first.
            self._actor(cur, "machine")
            cur.execute(
                "insert into public.media_assets (id, sku, brand, review_state) values (%s, 'SKU-ALPHA', 'Acme', 'pending')",
                (asset_id,),
            )
            # Human reviewer signs off on the SKU -> confirmed/human link.
            self._actor(cur, "human")
            cur.execute("update public.media_assets set sku = 'SKU-ALPHA' where id = %s", (asset_id,))
            rows = self._primary_link(cur, asset_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0], ("SKU-ALPHA", "primary", "confirmed", "human"))

            # Machine re-analysis tries to change the SKU.
            self._actor(cur, "machine")
            cur.execute("update public.media_assets set sku = 'SKU-MACHINE-NEW' where id = %s", (asset_id,))
            rows = self._primary_link(cur, asset_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0], ("SKU-ALPHA", "primary", "confirmed", "human"))
            # The guard reverted media_assets.sku too (dual-running alignment).
            cur.execute("select sku from public.media_assets where id = %s", (asset_id,))
            self.assertEqual(cur.fetchone()[0], "SKU-ALPHA")

    def test_case_3_human_repoint_confirmed_link(self):
        with self.conn.cursor() as cur:
            asset_id = str(uuid.uuid4())
            self._actor(cur, "human")
            cur.execute(
                "insert into public.media_assets (id, sku, brand, review_state) values (%s, 'SKU-ALPHA', 'Acme', 'approved')",
                (asset_id,),
            )
            # An INSERT fires the AFTER trigger as human -> confirmed link.
            rows = self._primary_link(cur, asset_id)
            self.assertEqual(rows, [("SKU-ALPHA", "primary", "confirmed", "human")])

            cur.execute("update public.media_assets set sku = 'SKU-GAMMA' where id = %s", (asset_id,))
            rows = self._primary_link(cur, asset_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0], ("SKU-GAMMA", "primary", "confirmed", "human"))
            # Exactly one non-rejected primary remains.
            cur.execute(
                "select count(*) from public.media_asset_products where media_asset_id = %s and role = 'primary' and review_state <> 'rejected'",
                (asset_id,),
            )
            self.assertEqual(cur.fetchone()[0], 1)

    def test_case_4_human_clear_deletes_confirmed_link(self):
        with self.conn.cursor() as cur:
            asset_id = str(uuid.uuid4())
            self._actor(cur, "human")
            cur.execute(
                "insert into public.media_assets (id, sku, brand, review_state) values (%s, 'SKU-ALPHA', 'Acme', 'approved')",
                (asset_id,),
            )
            self.assertEqual(len(self._primary_link(cur, asset_id)), 1)

            cur.execute("update public.media_assets set sku = null where id = %s", (asset_id,))
            cur.execute(
                "select count(*) from public.media_asset_products where media_asset_id = %s and role = 'primary'",
                (asset_id,),
            )
            self.assertEqual(cur.fetchone()[0], 0)
            cur.execute("select sku from public.media_assets where id = %s", (asset_id,))
            self.assertIsNone(cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main()
