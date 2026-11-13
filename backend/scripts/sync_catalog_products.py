"""Backfill WooCommerce identity and brand data into ``verity_products``.

This command does not call an embedding provider. It is safe to run before or
between reference seeding jobs and only enriches unknown/draft catalog fields;
non-unknown product brands are never overwritten.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import psycopg2
from dotenv import load_dotenv

from app.catalog_normalization import catalog_brand, classify_catalog_sku, normalize_catalog_sku
from app.postgres_repository import PostgresSettings


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync WooCommerce product identity into verity_products")
    parser.add_argument("--source", default=os.environ.get("WOOCOMMERCE_DATALAKE", ""), required=False)
    parser.add_argument("--confirm", action="store_true", help="Write catalog changes; otherwise dry-run")
    return parser.parse_args()


def load_rows(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise SystemExit("WooCommerce source must be a JSON array")
    return [row for row in payload if isinstance(row, dict)]


def connect_catalog_database() -> psycopg2.extensions.connection:
    """Connect only to the validated native PostgreSQL database."""

    settings = PostgresSettings.from_environment()
    return psycopg2.connect(
        settings.database_url,
        connect_timeout=settings.connect_timeout,
        application_name="verity-sync-catalog-products",
    )


def merge_products(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for row in rows:
        sku = normalize_catalog_sku(row.get("sku"))
        if not sku:
            continue
        current = merged.setdefault(
            sku,
            {
                "sku": sku,
                "display_name": sku,
                "brand": None,
                "sku_kind": classify_catalog_sku(sku),
                "external_id": str(row.get("id") or sku),
            },
        )
        name = row.get("name")
        if isinstance(name, str) and len(name.strip()) > len(current["display_name"]):
            current["display_name"] = name.strip()[:300]
        brand = catalog_brand(row)
        if brand and not current["brand"]:
            current["brand"] = brand
        if row.get("id") is not None:
            current["external_id"] = str(row["id"])
    return list(merged.values())


def main() -> int:
    args = parse_args()
    if not args.source:
        raise SystemExit("--source or WOOCOMMERCE_DATALAKE is required")
    items = merge_products(load_rows(Path(args.source)))
    print(f"[{('CONFIRM' if args.confirm else 'DRY-RUN')}] {len(items)} unique catalog identities")
    if not args.confirm:
        for item in items[:20]:
            print(item)
        return 0

    inserted = updated = brand_enriched = 0
    with connect_catalog_database() as connection:
        with connection.cursor() as cursor:
            for item in items:
                sku = item["sku"]
                brand = item["brand"] or "unknown"
                model_name = sku if item["sku_kind"] == "model_name" else None
                cursor.execute(
                    """
                    select id, brand, lifecycle
                    from public.verity_products
                    where lower(primary_sku) = lower(%s)
                       or lower(code) = lower(%s)
                       or (source_system = 'woocommerce' and external_id = %s)
                    order by (lifecycle = 'active') desc, created_at asc
                    limit 1
                    """,
                    (sku, sku, item["external_id"]),
                )
                existing = cursor.fetchone()
                if existing:
                    product_id, existing_brand, lifecycle = existing
                    should_enrich_brand = str(existing_brand or "").casefold() in {"", "unknown"} and brand != "unknown"
                    cursor.execute(
                        """
                        update public.verity_products
                        set display_name = case
                              when lifecycle = 'draft'
                                or nullif(trim(display_name), '') is null
                                or lower(trim(display_name)) in (lower(trim(primary_sku)), lower(trim(code)))
                                then %s else display_name end,
                            brand = case when %s then %s else coalesce(nullif(trim(brand), ''), 'unknown') end,
                            model_name = case
                              when lifecycle = 'draft' or nullif(trim(model_name), '') is null
                                then coalesce(nullif(%s, ''), model_name) else model_name end,
                            catalog_sku_kind = case
                              when catalog_sku_kind = 'unknown' or lifecycle = 'draft' then %s
                              else catalog_sku_kind end,
                            primary_sku = coalesce(nullif(primary_sku, ''), %s),
                            updated_at = now()
                        where id = %s
                        """,
                        (
                            item["display_name"], should_enrich_brand, brand,
                            model_name or "", item["sku_kind"], sku, product_id,
                        ),
                    )
                    updated += 1
                    brand_enriched += int(should_enrich_brand)
                    continue

                cursor.execute(
                    """
                    insert into public.verity_products
                      (code, display_name, brand, model_name, catalog_sku_kind,
                       primary_sku, lifecycle, source_system, external_id)
                    values (%s, %s, %s, %s, %s, %s, 'draft', 'woocommerce', %s)
                    """,
                    (
                        sku, item["display_name"], brand, model_name,
                        item["sku_kind"], sku, item["external_id"],
                    ),
                )
                inserted += 1
                brand_enriched += int(brand != "unknown")
    print(f"Done: inserted={inserted}, updated={updated}, brand_enriched={brand_enriched}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
