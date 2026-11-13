#!/usr/bin/env python3
"""Populate verity_products.aliases to bridge machine-code SKUs with model names.

Reads WooCommerce datalake products.json and verity_products from PostgreSQL,
matches human model names (e.g. 'Acme A100', 'Lockin V5 Max') with catalog
machine codes (e.g. 'AC-S02', 'XFCL201'), and updates the text[] aliases column
bidirectionally.

Usage:
    # Inspect proposed alias links (dry-run):
    python backend/scripts/populate_product_aliases.py

    # Apply updates to database:
    python backend/scripts/populate_product_aliases.py --confirm
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

DEFAULT_PRODUCTS_JSON = Path(
    r"D:\Downloads D\Study\WORK\Agent_Team_Agenthub\_datalake\woocommerce\products.json"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Populate verity_products.aliases bridging machine codes and model names"
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_PRODUCTS_JSON,
        help="Path to WooCommerce products.json",
    )
    parser.add_argument(
        "--ssh-key",
        default=r"C:\Users\ADMIN\.ssh\verity_vps_deploy_ed25519",
        help="Path to VPS SSH key",
    )
    parser.add_argument(
        "--ssh-host",
        default="root@203.0.113.10",
        help="SSH host",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        default=False,
        help="Write updates to database (default: dry-run)",
    )
    return parser.parse_args(argv)


def run_vps_psql(sql: str, ssh_key: str, ssh_host: str) -> subprocess.CompletedProcess[str]:
    cmd = [
        "ssh",
        "-i",
        ssh_key,
        "-o",
        "StrictHostKeyChecking=no",
        ssh_host,
        "docker exec -i verity_native_media_db psql -U verity -d verity_media",
    ]
    return subprocess.run(
        cmd,
        input=sql,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )


def fetch_all_products(ssh_key: str, ssh_host: str) -> list[dict[str, Any]]:
    """Fetch all rows from verity_products."""
    sql = "SELECT id, primary_sku, brand, display_name, source_system, array_to_string(aliases, '||') as alias_str FROM verity_products;"
    cmd = [
        "ssh",
        "-i",
        ssh_key,
        "-o",
        "StrictHostKeyChecking=no",
        ssh_host,
        'docker exec -i verity_native_media_db psql -U verity -d verity_media -A -F "\t" -t',
    ]
    res = subprocess.run(cmd, input=sql, text=True, capture_output=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"Error fetching verity_products: {res.stderr}")

    products = []
    for line in res.stdout.strip().split("\n"):
        parts = line.split("\t")
        if len(parts) >= 5:
            aliases = [a.strip() for a in parts[5].split("||") if a.strip()] if len(parts) > 5 and parts[5] else []
            products.append({
                "id": parts[0].strip(),
                "primary_sku": parts[1].strip(),
                "brand": parts[2].strip() if parts[2] else None,
                "display_name": parts[3].strip() if parts[3] else None,
                "source_system": parts[4].strip(),
                "aliases": aliases,
            })
    return products


def normalize_string(val: str) -> str:
    """Normalize string for fuzzy matching (lowercase, alphanumeric single spaces)."""
    return re.sub(r"[^a-z0-9]+", " ", val.lower()).strip()


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args(argv)

    if not args.source.exists():
        print(f"ERROR: WooCommerce products.json not found at {args.source}")
        return 1

    print(f"Loading WooCommerce datalake: {args.source}...")
    with open(args.source, "r", encoding="utf-8") as f:
        wc_products = json.load(f)
    print(f"WooCommerce catalog loaded: {len(wc_products)} items.")

    print(f"Querying verity_products from DB via {args.ssh_host}...")
    db_products = fetch_all_products(args.ssh_key, args.ssh_host)
    print(f"DB verity_products loaded: {len(db_products)} items.")

    # Index DB products by primary_sku and by id
    by_sku = {p["primary_sku"]: p for p in db_products}
    by_id = {p["id"]: p for p in db_products}

    # Identify auto_sku products and catalog products
    auto_skus = [p for p in db_products if p["source_system"] == "auto_sku"]
    print(f"Found {len(auto_skus)} auto_sku products in DB:")
    for a in auto_skus:
        print(f"  - {a['primary_sku']} ({a['brand']}) [current aliases: {a['aliases']}]")

    # Build index of WooCommerce products: (sku -> name, brand)
    wc_map = {}
    for item in wc_products:
        sku = str(item.get("sku") or "").strip()
        name = str(item.get("name") or "").strip()
        if sku and name:
            wc_map[sku] = {
                "name": name,
                "norm_name": normalize_string(name),
                "sku": sku,
            }

    # Match each auto_sku against WooCommerce products and DB backfill products
    updates: dict[str, set[str]] = {}  # product_id -> set of new aliases to add

    for auto in auto_skus:
        auto_sku_str = auto["primary_sku"]
        norm_auto = normalize_string(auto_sku_str)
        auto_brand = (auto["brand"] or "").strip().lower()

        # Find matching WooCommerce items
        matched_wc_skus = []
        for wc_sku, wc_info in wc_map.items():
            norm_wc = wc_info["norm_name"]
            # Exact word sequence match
            if norm_auto in norm_wc:
                matched_wc_skus.append(wc_sku)
            elif auto_brand and auto_brand in norm_wc:
                # e.g. "a100" in "khoa cua van tay thong minh acme a100"
                model_part = normalize_string(auto_sku_str.replace(auto["brand"], ""))
                if model_part and len(model_part) >= 3 and f" {model_part} " in f" {norm_wc} ":
                    matched_wc_skus.append(wc_sku)

        if matched_wc_skus:
            print(f"\nMatch found for '{auto_sku_str}': {matched_wc_skus}")
            # Add WC SKUs as aliases to auto_sku product
            updates.setdefault(auto["id"], set()).update(matched_wc_skus)

            # Also add auto_sku name as alias to the corresponding catalog product in DB
            for m_sku in matched_wc_skus:
                if m_sku in by_sku:
                    target_prod = by_sku[m_sku]
                    updates.setdefault(target_prod["id"], set()).add(auto_sku_str)
                    print(f"  -> Link to DB product {target_prod['primary_sku']} ('{target_prod['display_name'][:50]}')")

    # Also check other key lock models in DB that might have empty aliases
    # (e.g. AC-S02 -> "Acme A100", AC-S20 -> "Acme M100", AC-S16 -> "Acme N100", K2C-H(W)-B -> "Imex K2C")
    explicit_aliases = [
        ("AC-S02", "Acme A100"),
        ("AC-S20", "Acme M100"),
        ("AC-S16", "Acme N100"),
        ("K2C-H(W)-B", "Imex K2C"),
        ("TFPL407", "Lockin X9"),
        ("TFPL408", "Lockin X9 Pro"),
        ("PFPL908", "Lockin S30 Pro"),
        ("XFCL108", "Lockin S50F"),
        ("XFCL201", "Lockin V5 Max"),
        ("ML-D01D", "Acme D200"),
        ("DEMO-007", "Eden DL05"),
    ]

    for machine_sku, model_name in explicit_aliases:
        if machine_sku in by_sku:
            p = by_sku[machine_sku]
            updates.setdefault(p["id"], set()).add(model_name)
        if model_name in by_sku:
            p = by_sku[model_name]
            updates.setdefault(p["id"], set()).add(machine_sku)

    # Filter out aliases already present
    final_updates = {}
    for pid, new_aliases in updates.items():
        prod = by_id[pid]
        current_set = set(prod["aliases"])
        needed = new_aliases - current_set
        if needed:
            final_updates[pid] = needed

    print(f"\nSummary of Updates Needed ({len(final_updates)} products):")
    for pid, aliases_to_add in final_updates.items():
        prod = by_id[pid]
        print(f"  Product [{prod['primary_sku']}] ({prod['source_system']}): add aliases {sorted(aliases_to_add)}")

    if not args.confirm:
        print("\n[DRY-RUN MODE] No changes made to database.")
        print("Run with --confirm to write aliases to verity_products.")
        return 0

    print(f"\n[CONFIRM MODE] Updating verity_products.aliases for {len(final_updates)} products...")
    sql_lines = ["BEGIN;"]
    for pid, aliases_to_add in final_updates.items():
        for alias in aliases_to_add:
            escaped_alias = alias.replace("'", "''")
            sql_lines.append(
                f"UPDATE public.verity_products "
                f"SET aliases = array_append(aliases, '{escaped_alias}') "
                f"WHERE id = '{pid}' AND NOT ('{escaped_alias}' = ANY(aliases));"
            )
    sql_lines.append("COMMIT;")
    batch_sql = "\n".join(sql_lines)

    res = run_vps_psql(batch_sql, args.ssh_key, args.ssh_host)
    if res.returncode != 0 or "ERROR" in res.stderr:
        print(f"ERROR executing updates: {res.stderr}")
        return 1

    print("Aliases updated successfully! Verifying updated rows...")
    check_sql = f"SELECT primary_sku, source_system, aliases FROM verity_products WHERE id IN ({','.join(repr(p) for p in final_updates.keys())}) ORDER BY primary_sku;"
    cmd = [
        "ssh",
        "-i",
        args.ssh_key,
        "-o",
        "StrictHostKeyChecking=no",
        args.ssh_host,
        f'docker exec -i verity_native_media_db psql -U verity -d verity_media -c "{check_sql}"',
    ]
    res = subprocess.run(cmd, text=True, capture_output=True, encoding="utf-8")
    print(res.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
