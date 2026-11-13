"""Mandatory live integration smoke test for the native SKU trigger path.

This is intentionally self-contained so it can run in the production worker
image (which does not ship pytest or the repository test tree).  Every write is
inside one transaction that is rolled back before exit.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

import psycopg2

from app.postgres_repository import PostgresConfigurationError, PostgresSettings


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = "0012_harden_native_sku_product_sync.sql"


def _dsn() -> str:
    try:
        return PostgresSettings.from_environment().database_url
    except PostgresConfigurationError as error:
        raise SystemExit(str(error)) from error


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run() -> None:
    expected = hashlib.sha256(
        (ROOT / "migrations" / MIGRATION).read_bytes().replace(b"\r\n", b"\n")
    ).hexdigest()
    with psycopg2.connect(_dsn(), connect_timeout=10) as connection:
        with connection.cursor() as cursor:
            cursor.execute("select checksum from verity.migration_state where migration_id = %s", (MIGRATION,))
            row = cursor.fetchone()
            _assert(row and row[0] == expected, "migration 0012 checksum is not applied")
            cursor.execute(
                """
                select count(*) from pg_trigger
                 where tgrelid = 'public.media_assets'::regclass
                   and tgname = 'media_assets_sync_primary_product'
                   and not tgisinternal
                """
            )
            _assert(cursor.fetchone()[0] == 1, "native SKU sync trigger is not attached")

            asset_id = str(uuid.uuid4())
            discontinued_code = f"GATE-DISCONTINUED-{asset_id[:8]}"
            discontinued_variant = discontinued_code.lower()
            malformed_sku = f"GATE-MALFORMED-{asset_id[:8]}"

            cursor.execute("select set_config('verity.sync_actor', 'machine', true)")
            cursor.execute("select set_config('verity.sync_actor_id', %s, true)", (str(uuid.uuid4()),))
            cursor.execute(
                "insert into public.verity_products (code, display_name, brand, primary_sku, lifecycle, source_system, external_id) values (%s,%s,'gate',%s,'discontinued','gate',%s)",
                (discontinued_code, discontinued_code, discontinued_code, discontinued_code),
            )
            cursor.execute(
                "insert into public.media_assets (id, sku, brand, review_state) values (%s,%s,'gate','pending')",
                (asset_id, discontinued_variant),
            )
            cursor.execute(
                "select count(*) from public.media_asset_products where media_asset_id=%s and role='primary' and review_state <> 'rejected'",
                (asset_id,),
            )
            _assert(cursor.fetchone()[0] == 0, "discontinued SKU received an operational link")

            cursor.execute(
                "update public.media_assets set sku=%s, ai_confidence=jsonb_build_object('sku','not-a-number') where id=%s",
                (malformed_sku, asset_id),
            )
            cursor.execute(
                "select map.review_state, map.source, map.confidence from public.media_asset_products map join public.verity_products p on p.id=map.product_id where map.media_asset_id=%s and map.role='primary'",
                (asset_id,),
            )
            row = cursor.fetchone()
            _assert(row == ('draft', 'sku_embedding', 0.0), f"malformed confidence handling mismatch: {row!r}")

            cursor.execute("select set_config('verity.sync_actor', 'human', true)")
            cursor.execute("update public.media_assets set review_state='approved' where id=%s", (asset_id,))
            cursor.execute(
                "select review_state, source from public.media_asset_products where media_asset_id=%s and role='primary' and review_state <> 'rejected'",
                (asset_id,),
            )
            _assert(cursor.fetchone() == ('confirmed', 'human'), "human approval did not confirm the link")

            cursor.execute("select set_config('verity.sync_actor', 'machine', true)")
            cursor.execute("update public.media_assets set sku=%s where id=%s", (discontinued_code, asset_id))
            cursor.execute("select sku from public.media_assets where id=%s", (asset_id,))
            _assert(cursor.fetchone()[0] == malformed_sku, "machine write overrode a confirmed SKU")

            cursor.execute("update public.media_assets set review_state='rejected' where id=%s", (asset_id,))
            cursor.execute(
                "select count(*) from public.media_asset_products where media_asset_id=%s and role='primary' and review_state <> 'rejected'",
                (asset_id,),
            )
            _assert(cursor.fetchone()[0] == 0, "rejected asset retained an operational primary link")
            connection.rollback()
    print("NATIVE_INTEGRATION_GATE_OK")


if __name__ == "__main__":
    run()
