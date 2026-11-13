"""Fail-closed preflight for the native PostgreSQL release gate.

The check is deliberately read-only.  It audits the data conditions that can
make the one-time SKU backfill unsafe and verifies the migration checksum after
the migration runner completes.  A missing DATABASE_URL or an unreachable DB
is an error, never a skip.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import psycopg2

from app.postgres_repository import PostgresConfigurationError, PostgresSettings


ROOT = Path(__file__).resolve().parents[1]
MIGRATION_0011 = "0011_media_asset_product_sku_sync.sql"
MIGRATION_0011_CHECKSUM = "68b496ca75df794aac4ea56a0b53bc20f58c52d6642bc1807a321081be6569de"
MIGRATION_0012 = "0012_harden_native_sku_product_sync.sql"


def _dsn() -> str:
    try:
        return PostgresSettings.from_environment().database_url
    except PostgresConfigurationError as error:
        raise SystemExit(str(error)) from error


def _count(cursor, query: str) -> int:
    cursor.execute(query)
    return int(cursor.fetchone()[0])


def run(phase: str) -> None:
    with psycopg2.connect(_dsn(), connect_timeout=10) as connection:
        with connection.cursor() as cursor:
            has_assets = _count(cursor, "select to_regclass('public.media_assets') is not null")
            if not has_assets:
                if phase == "after":
                    raise SystemExit("NATIVE_PREFLIGHT_FAILED: media_assets table is missing after migration")
                print("NATIVE_PREFLIGHT_OK phase=before database=empty")
                return

            checks = {
                "multiple_primary": _count(
                    cursor,
                    """
                    select count(*) from (
                      select media_asset_id
                        from public.media_asset_products
                       where role = 'primary' and review_state <> 'rejected'
                       group by media_asset_id
                      having count(*) > 1
                    ) conflicts
                    """,
                ),
                "rejected_active_primary": _count(
                    cursor,
                    """
                    select count(*)
                      from public.media_asset_products map
                      join public.media_assets asset on asset.id = map.media_asset_id
                     where map.role = 'primary'
                       and map.review_state <> 'rejected'
                       and asset.review_state = 'rejected'
                    """,
                ),
                "primary_without_live_sku": _count(
                    cursor,
                    """
                    select count(*)
                      from public.media_asset_products map
                      join public.media_assets asset on asset.id = map.media_asset_id
                     where map.role = 'primary'
                       and map.review_state <> 'rejected'
                       and (asset.deleted_at is not null or asset.sku is null or trim(asset.sku) = '')
                    """,
                ),
                "malformed_confidence": _count(
                    cursor,
                    """
                    select count(*)
                      from public.media_assets
                     where ai_confidence ? 'sku'
                       and nullif(trim(ai_confidence ->> 'sku'), '') is not null
                       and (ai_confidence ->> 'sku') !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
                    """,
                ),
                "case_variant_skus": _count(
                    cursor,
                    """
                    with sku_values as (
                      select trim(sku) as raw_sku from public.media_assets
                       where sku is not null and trim(sku) <> ''
                      union all
                      select trim(sku) as raw_sku from public.sku_reference_embeddings
                       where sku is not null and trim(sku) <> ''
                    )
                    select count(*) from (
                      select lower(raw_sku)
                        from sku_values
                       group by lower(raw_sku)
                      having count(distinct raw_sku) > 1
                    ) variants
                    """,
                ),
                "primary_product_mismatch": _count(
                    cursor,
                    """
                    with resolved as (
                      select asset.id as media_asset_id,
                             (select product.id
                                from public.verity_products product
                               where product.lifecycle <> 'discontinued'
                                 and (lower(product.primary_sku) = lower(trim(asset.sku))
                                   or lower(product.code) = lower(trim(asset.sku))
                                   or exists (
                                         select 1 from unnest(product.aliases) alias
                                          where lower(alias) = lower(trim(asset.sku))))
                               order by (product.lifecycle = 'active') desc, product.created_at asc
                               limit 1) as product_id
                        from public.media_assets asset
                       where asset.sku is not null
                         and trim(asset.sku) <> ''
                         and asset.deleted_at is null
                         and asset.review_state <> 'rejected'
                    )
                    select count(*)
                      from resolved
                      join public.media_asset_products map
                        on map.media_asset_id = resolved.media_asset_id
                       and map.role = 'primary'
                       and map.review_state <> 'rejected'
                     where resolved.product_id is not null
                       and map.product_id <> resolved.product_id
                    """,
                ),
                "discontinued_only_skus": _count(
                    cursor,
                    """
                    select count(*)
                      from public.media_assets asset
                     where asset.sku is not null
                       and trim(asset.sku) <> ''
                       and asset.deleted_at is null
                       and asset.review_state <> 'rejected'
                       and exists (
                         select 1 from public.verity_products product
                          where product.lifecycle = 'discontinued'
                            and (lower(product.primary_sku) = lower(trim(asset.sku))
                              or lower(product.code) = lower(trim(asset.sku))
                              or exists (
                                  select 1 from unnest(product.aliases) alias
                                   where lower(alias) = lower(trim(asset.sku))))
                       )
                       and not exists (
                         select 1 from public.verity_products product
                          where product.lifecycle <> 'discontinued'
                            and (lower(product.primary_sku) = lower(trim(asset.sku))
                              or lower(product.code) = lower(trim(asset.sku))
                              or exists (
                                  select 1 from unnest(product.aliases) alias
                                   where lower(alias) = lower(trim(asset.sku))))
                       )
                    """,
                ),
            }

            if phase == "after":
                cursor.execute(
                    "select checksum from verity.migration_state where migration_id = %s",
                    (MIGRATION_0012,),
                )
                recorded = cursor.fetchone()
                expected = hashlib.sha256(
                    (ROOT / "migrations" / MIGRATION_0012).read_bytes().replace(b"\r\n", b"\n")
                ).hexdigest()
                if not recorded or recorded[0] != expected:
                    raise SystemExit("NATIVE_PREFLIGHT_FAILED: migration 0012 checksum is not recorded")
                cursor.execute(
                    "select checksum from verity.migration_state where migration_id = %s",
                    (MIGRATION_0011,),
                )
                recorded_0011 = cursor.fetchone()
                if not recorded_0011 or recorded_0011[0] != MIGRATION_0011_CHECKSUM:
                    raise SystemExit("NATIVE_PREFLIGHT_FAILED: migration 0011 checksum drift")

            failures = {name: value for name, value in checks.items() if value}
            # Migration 0012/0013 intentionally reconciles historical rejected
            # primary rows and soft-deleted rows created before 0013.  Allow those
            # known conditions in the before phase; all other violations still fail
            # closed and the after phase requires it to be zero.
            if phase == "before":
                failures.pop("rejected_active_primary", None)
                failures.pop("primary_without_live_sku", None)
            if failures:
                details = ", ".join(f"{name}={value}" for name, value in sorted(failures.items()))
                raise SystemExit(f"NATIVE_PREFLIGHT_FAILED: {details}")

            summary = " ".join(f"{name}={value}" for name, value in sorted(checks.items()))
            print(f"NATIVE_PREFLIGHT_OK phase={phase} {summary}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("before", "after"), required=True)
    args = parser.parse_args()
    run(args.phase)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
