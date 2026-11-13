#!/usr/bin/env python3
"""Bulk import precomputed SigLIP2 embeddings from Parquet into PostgreSQL.

Reads ``woocommerce_siglip2_catalog.parquet`` (7,190 images, 1,661 unique SKUs)
and inserts references into ``sku_references`` and ``reference_embeddings``
for the production space ``verity-siglip2-b32-256-webli-v1``.

Zero external API calls: embeddings are already computed.

Usage:
    # Inspect what would be imported (dry-run):
    python backend/scripts/bulk_import_parquet_references.py

    # Execute import:
    python backend/scripts/bulk_import_parquet_references.py --confirm
"""

from __future__ import annotations

import argparse
import io
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pandas as pd

DEFAULT_PARQUET_PATH = Path(
    r"backend\benchmarks\siglip2\woocommerce_catalog\woocommerce_siglip2_catalog.parquet"
)
SIGLIP2_SPACE_ID = "verity-siglip2-b32-256-webli-v1"
DEFAULT_MAX_IMAGES_PER_SKU = 3
CHUNK_SIZE = 50


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bulk import precomputed SigLIP2 embeddings from parquet into PostgreSQL"
    )
    parser.add_argument(
        "--parquet",
        type=Path,
        default=DEFAULT_PARQUET_PATH,
        help="Path to parquet catalog file",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        default=DEFAULT_MAX_IMAGES_PER_SKU,
        help="Maximum reference images per SKU (default: 3)",
    )
    parser.add_argument(
        "--ssh-key",
        default=r"C:\Users\ADMIN\.ssh\verity_vps_deploy_ed25519",
        help="Path to VPS SSH key",
    )
    parser.add_argument(
        "--ssh-host",
        default="root@203.0.113.10",
        help="SSH host (default: root@203.0.113.10)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        default=False,
        help="Execute the import against the database (default: dry-run)",
    )
    return parser.parse_args(argv)


def run_vps_psql(sql: str, ssh_key: str, ssh_host: str) -> subprocess.CompletedProcess[str]:
    """Execute SQL on VPS PostgreSQL container via SSH."""
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


def fetch_existing_references(ssh_key: str, ssh_host: str) -> tuple[set[tuple[str, str]], set[str]]:
    """Fetch existing (sku, source_url) pairs and unique skus from DB."""
    sql = "SELECT sku, source_url FROM sku_references WHERE source_url IS NOT NULL;"
    cmd = [
        "ssh",
        "-i",
        ssh_key,
        "-o",
        "StrictHostKeyChecking=no",
        ssh_host,
        'docker exec -i verity_native_media_db psql -U verity -d verity_media -A -F "|" -t',
    ]
    res = subprocess.run(cmd, input=sql, text=True, capture_output=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"Failed to query DB for existing references: {res.stderr}")

    pairs: set[tuple[str, str]] = set()
    skus: set[str] = set()
    for line in res.stdout.strip().split("\n"):
        parts = line.split("|")
        if len(parts) >= 2:
            s = parts[0].strip()
            u = parts[1].strip()
            if s and u:
                pairs.add((s, u))
                skus.add(s)
    return pairs, skus


def escape_sql_string(val: str) -> str:
    """Escape single quotes for SQL string literal."""
    return val.replace("'", "''")


def format_vector(arr: Any) -> str:
    """Format numpy array or list into pgvector string literal '[x,y,...]'."""
    return "[" + ",".join(f"{float(x):.6f}" for x in arr) + "]"


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args(argv)

    if not args.parquet.exists():
        print(f"ERROR: Parquet file not found at {args.parquet}")
        return 1

    print(f"Reading Parquet file: {args.parquet}...")
    df = pd.read_parquet(args.parquet)
    print(f"Parquet loaded: {len(df)} rows, {df['sku'].nunique()} unique SKUs")

    print(f"Querying DB for existing references via {args.ssh_host}...")
    existing_pairs, existing_skus = fetch_existing_references(args.ssh_key, args.ssh_host)
    print(f"DB currently has: {len(existing_pairs)} (sku, url) pairs across {len(existing_skus)} unique SKUs")

    # Group by SKU and take up to max_images
    # Deduplicate by (sku, image_url)
    df_clean = df.drop_duplicates(subset=["sku", "image_url"]).copy()
    grouped = df_clean.groupby("sku")

    to_import: list[dict[str, Any]] = []
    skipped_existing = 0
    skipped_limit = 0

    for sku_val, group in grouped:
        sku = str(sku_val).strip()
        if not sku:
            continue
        
        count_for_sku = 0
        for idx, row in group.iterrows():
            url = str(row["image_url"]).strip()
            if not url or not url.startswith("https://"):
                continue

            if (sku, url) in existing_pairs:
                skipped_existing += 1
                count_for_sku += 1
                continue

            if count_for_sku >= args.max_images:
                skipped_limit += 1
                continue

            to_import.append({
                "sku": sku,
                "product_name": str(row.get("product_name", "")).strip(),
                "image_url": url,
                "sha256": str(row.get("sha256", "")).strip(),
                "embedding": row["embedding"],
                "is_first": (count_for_sku == 0),
            })
            count_for_sku += 1

    unique_to_import_skus = len({item["sku"] for item in to_import})
    print(f"\nImport Candidate Analysis (max {args.max_images} imgs/SKU):")
    print(f"  - Total new references to import: {len(to_import)}")
    print(f"  - Unique SKUs covered: {unique_to_import_skus}")
    print(f"  - Skipped (already in DB): {skipped_existing}")
    print(f"  - Skipped (exceeded max {args.max_images} images/SKU): {skipped_limit}")

    # Check key targets
    key_targets = ["AC-S02", "AC-S20", "AC-S16", "DEMO-007", "XFCL201", "XFCL108", "PFPL908", "TFPL407", "TFPL408", "K2C-H(W)-B"]
    found_targets = [t for t in key_targets if any(item["sku"] == t for item in to_import)]
    print(f"\nKey target models to be imported ({len(found_targets)}/{len(key_targets)}):")
    for t in key_targets:
        cnt = sum(1 for item in to_import if item["sku"] == t)
        print(f"  {t}: {cnt} images queued")

    if not args.confirm:
        print("\n[DRY-RUN MODE] No changes made to database.")
        print("Run with --confirm to execute the bulk import.")
        return 0

    print(f"\n[CONFIRM MODE] Beginning bulk import of {len(to_import)} references...")

    # Execute in chunks
    total_chunks = (len(to_import) + CHUNK_SIZE - 1) // CHUNK_SIZE
    imported_count = 0

    for chunk_idx in range(total_chunks):
        chunk = to_import[chunk_idx * CHUNK_SIZE : (chunk_idx + 1) * CHUNK_SIZE]
        sql_lines = ["BEGIN;"]

        for item in chunk:
            ref_id = str(uuid.uuid4())
            emb_id = str(uuid.uuid4())
            sku = escape_sql_string(item["sku"])
            url = escape_sql_string(item["image_url"])
            sha = escape_sql_string(item["sha256"])
            vec_str = format_vector(item["embedding"])
            role = "HERO" if item["is_first"] else "ANGLE"

            # Insert sku_references — HERO/ANGLE are always STUDIO category
            sql_lines.append(
                f"INSERT INTO public.sku_references "
                f"(reference_id, sku, source_url, verified, match_eligible, reference_role, image_category, curation_status, is_primary, is_active, is_frozen_benchmark) "
                f"VALUES ('{ref_id}', '{sku}', '{url}', true, true, '{role}', 'STUDIO', 'UNREVIEWED', {str(bool(item['is_first'])).lower()}, true, false) "
                f"ON CONFLICT (sku, source_url) WHERE (source_url IS NOT NULL) DO UPDATE SET "
                f"is_primary = public.sku_references.is_primary OR EXCLUDED.is_primary, "
                f"match_eligible = true, is_active = true, updated_at = now();"
            )

            # Insert reference_embeddings (lookup reference_id in case conflict occurred)
            sql_lines.append(
                f"INSERT INTO public.reference_embeddings "
                f"(id, reference_id, space_id, vector, source_sha256) "
                f"SELECT '{emb_id}', r.reference_id, '{SIGLIP2_SPACE_ID}', '{vec_str}'::vector, '{sha}' "
                f"FROM public.sku_references r "
                f"WHERE r.sku = '{sku}' AND r.source_url = '{url}' "
                f"ON CONFLICT (reference_id, space_id) DO NOTHING;"
            )

        sql_lines.append("COMMIT;")
        batch_sql = "\n".join(sql_lines)

        res = run_vps_psql(batch_sql, args.ssh_key, args.ssh_host)
        if res.returncode != 0 or "ERROR" in res.stderr:
            print(f"ERROR on chunk {chunk_idx + 1}/{total_chunks}: {res.stderr}")
            return 1

        imported_count += len(chunk)
        if (chunk_idx + 1) % 10 == 0 or chunk_idx == total_chunks - 1:
            print(f"  Progress: {imported_count}/{len(to_import)} references inserted ({chunk_idx + 1}/{total_chunks} batches)...")

    print("\nBulk import complete! Verifying new totals in database...")
    after_pairs, after_skus = fetch_existing_references(args.ssh_key, args.ssh_host)
    print(f"DB now has: {len(after_pairs)} (sku, url) pairs across {len(after_skus)} unique SKUs!")
    print(f"Net gain: +{len(after_pairs) - len(existing_pairs)} reference images, +{len(after_skus) - len(existing_skus)} new SKUs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
