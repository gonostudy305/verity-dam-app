#!/usr/bin/env python3
"""Audit approved production assets against the canonical SKU reference corpus.

The report is deliberately read-only.  It never infers an SKU from Vision
metadata alone and never mutates ``media_assets``.  A future apply command can
consume only the ``auto_candidate`` rows after a human has reviewed the report.

Usage:
    python -m scripts.audit_sku_reconciliation
    python -m scripts.audit_sku_reconciliation --all-assets --json-out report.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

CANONICAL_SPACE = "verity-siglip2-b32-256-webli-v1"
SSH_KEY = Path.home() / ".ssh" / "verity_vps_deploy_ed25519"
SSH_HOST = "root@203.0.113.10"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-key", default=str(SSH_KEY))
    parser.add_argument("--ssh-host", default=SSH_HOST)
    parser.add_argument("--all-assets", action="store_true", help="Include assets that already have an SKU")
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--mismatch-limit", type=int, default=50,
                        help="Maximum existing-SKU mismatches to print (JSON still contains all rows)")
    return parser.parse_args()


def build_query(include_all: bool) -> str:
    current_filter = "" if include_all else "AND a.sku IS NULL"
    return f"""
WITH targets AS (
    SELECT a.id AS asset_id, a.sku AS current_sku, a.title, a.brand,
           a.category, a.space, a.file_url, ae.vector
    FROM public.media_assets a
    JOIN public.asset_embeddings ae
      ON ae.asset_id = a.id
     AND ae.space_id = '{CANONICAL_SPACE}'
     AND ae.kind = 'global'
    WHERE a.deleted_at IS NULL
      AND a.review_state = 'approved'
      {current_filter}
),
raw_hits AS (
    SELECT t.asset_id, t.current_sku, t.title, t.brand, t.category, t.space,
           t.file_url, h.sku, h.dist
    FROM targets t
    CROSS JOIN LATERAL (
        SELECT r.sku, re.vector <=> t.vector AS dist
        FROM public.reference_embeddings re
        JOIN public.sku_references r ON r.reference_id = re.reference_id
        WHERE re.space_id = '{CANONICAL_SPACE}'
          AND r.is_active = true
          AND r.match_eligible = true
          AND EXISTS (
              SELECT 1
              FROM public.sku_references primary_ref
              WHERE primary_ref.sku = r.sku
                AND primary_ref.is_active = true
                AND primary_ref.match_eligible = true
                AND primary_ref.is_primary = true
          )
        ORDER BY re.vector <=> t.vector
        LIMIT 160
    ) h
),
raw_candidates AS (
    SELECT *, row_number() OVER (PARTITION BY asset_id ORDER BY min_dist, sku) AS raw_rn
    FROM (
        SELECT asset_id, current_sku, title, brand, category, space, file_url,
               sku, min(dist) AS min_dist
        FROM raw_hits
        GROUP BY asset_id, current_sku, title, brand, category, space, file_url, sku
    ) candidates
),
scored AS (
    SELECT c.asset_id, c.current_sku, c.title, c.brand, c.category, c.space,
           c.file_url, c.sku,
           (
               coalesce((
                   SELECT 1 - (re.vector <=> t.vector)
                   FROM public.reference_embeddings re
                   JOIN public.sku_references r ON r.reference_id = re.reference_id
                   WHERE re.space_id = '{CANONICAL_SPACE}'
                     AND r.sku = c.sku
                     AND r.is_active = true
                     AND r.match_eligible = true
                   ORDER BY re.vector <=> t.vector
                   LIMIT 1
               ), 0) * 0.3
               + coalesce((
                   SELECT 1 - (re.vector <=> t.vector)
                   FROM public.reference_embeddings re
                   JOIN public.sku_references r ON r.reference_id = re.reference_id
                   WHERE re.space_id = '{CANONICAL_SPACE}'
                     AND r.sku = c.sku
                     AND r.is_active = true
                     AND r.is_primary = true
                     AND r.match_eligible = true
                   ORDER BY re.vector <=> t.vector
                   LIMIT 1
               ), coalesce((
                   SELECT 1 - (re.vector <=> t.vector)
                   FROM public.reference_embeddings re
                   JOIN public.sku_references r ON r.reference_id = re.reference_id
                   WHERE re.space_id = '{CANONICAL_SPACE}'
                     AND r.sku = c.sku
                     AND r.is_active = true
                     AND r.match_eligible = true
                   ORDER BY re.vector <=> t.vector
                   LIMIT 1
               ), 0) * 0.85) * 0.7
           ) AS similarity
    FROM raw_candidates c
    JOIN targets t ON t.asset_id = c.asset_id
    WHERE c.raw_rn <= 40
),
ranked AS (
    SELECT *, row_number() OVER (PARTITION BY asset_id ORDER BY similarity DESC, sku) AS rn
    FROM scored
),
summary AS (
    SELECT asset_id, current_sku, title, brand, category, space, file_url,
           max(similarity) FILTER (WHERE rn = 1) AS top1_similarity,
           max(sku) FILTER (WHERE rn = 1) AS top1_sku,
           max(similarity) FILTER (WHERE rn = 2) AS top2_similarity,
           max(sku) FILTER (WHERE rn = 2) AS top2_sku
    FROM ranked
    GROUP BY asset_id, current_sku, title, brand, category, space, file_url
)
SELECT asset_id, coalesce(current_sku, ''), coalesce(title, ''),
       coalesce(brand, ''), coalesce(category, ''), coalesce(space, ''),
       coalesce(file_url, ''), coalesce(top1_sku, ''),
       coalesce(top1_similarity, 0), coalesce(top2_sku, ''),
       coalesce(top2_similarity, 0)
FROM summary
ORDER BY top1_similarity DESC, asset_id;
"""


def fetch_rows(sql: str, ssh_key: str, ssh_host: str) -> list[dict[str, Any]]:
    command = [
        "ssh", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", ssh_key,
        ssh_host,
        "docker exec -i verity_native_media_db psql -U verity -d verity_media -A -F '|' -t",
    ]
    result = subprocess.run(command, input=sql, text=True, capture_output=True,
                            encoding="utf-8", errors="replace", check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "production query failed")

    rows: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        values = line.split("|")
        if len(values) != 11:
            continue
        top1 = float(values[8])
        top2 = float(values[10])
        margin = top1 - top2
        if top1 >= 0.90 and margin >= 0.08:
            verdict = "auto_candidate"
        elif top1 < 0.70:
            verdict = "reference_gap_or_non_product"
        else:
            verdict = "review_required"
        rows.append({
            "asset_id": values[0],
            "current_sku": values[1] or None,
            "title": values[2],
            "brand": values[3],
            "category": values[4],
            "space": values[5],
            "file_url": values[6],
            "top1_sku": values[7] or None,
            "top1_similarity": top1,
            "top2_sku": values[9] or None,
            "top2_similarity": top2,
            "margin": margin,
            "verdict": verdict,
        })
    return rows


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args()
    rows = fetch_rows(build_query(args.all_assets), args.ssh_key, args.ssh_host)
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1

    print(f"Assets audited: {len(rows)}")
    for verdict in ("auto_candidate", "review_required", "reference_gap_or_non_product"):
        print(f"  {verdict}: {counts.get(verdict, 0)}")

    with_sku = [row for row in rows if row["current_sku"]]
    missing_sku = [row for row in rows if not row["current_sku"]]
    mismatches = [
        row for row in with_sku
        if row["top1_sku"] and row["current_sku"].casefold() != row["top1_sku"].casefold()
    ]
    print(f"  current_sku_present: {len(with_sku)}")
    print(f"  current_sku_missing: {len(missing_sku)}")
    print(f"  current_sku_differs_from_top1: {len(mismatches)}")

    print("\nHigh-confidence candidates (still read-only; no SKU mutation):")
    for row in rows:
        if row["verdict"] == "auto_candidate":
            print(
                f"  {row['asset_id']} | current={row['current_sku'] or '-'} "
                f"| top1={row['top1_sku']} {row['top1_similarity']:.4f} "
                f"| top2={row['top2_sku']} {row['top2_similarity']:.4f} "
                f"| margin={row['margin']:.4f}"
            )

    print("\nExisting SKU differs from embedding top1 (review only):")
    for row in mismatches[:args.mismatch_limit]:
        print(
            f"  {row['asset_id']} | current={row['current_sku']} "
            f"| top1={row['top1_sku']} {row['top1_similarity']:.4f} "
            f"| top2={row['top2_sku']} {row['top2_similarity']:.4f} "
            f"| margin={row['margin']:.4f} | {row['title'][:80]}"
        )
    if len(mismatches) > args.mismatch_limit:
        print(f"  ... {len(mismatches) - args.mismatch_limit} more; use --json-out for the full report")

    print("\nReference-gap / non-product rows:")
    for row in rows:
        if row["verdict"] == "reference_gap_or_non_product":
            print(f"  {row['asset_id']} | {row['top1_similarity']:.4f} | {row['top1_sku']} | {row['title'][:100]}")

    if args.json_out:
        args.json_out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nReport written: {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
