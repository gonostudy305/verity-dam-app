"""Quarantine uncurated non-product references from the AI candidate matching pool.

Safe operation:
- Flips match_eligible = false
- Maps reference_role from media_assets.category (INSTALLATION, BANNER, REAL_WORLD, LIFESTYLE, UNCLASSIFIED)
- Sets curation_status = 'UNREVIEWED'
- Never touches is_frozen_benchmark = true (Gate Q0 protection)
- Never touches human-curated rows (reference_role != 'UNCLASSIFIED')
- Never deletes reference_embeddings vectors (keeps operation reversible)
- Runs in --dry-run mode by default; requires explicit --apply to write changes.

Usage:
    python -m scripts.quarantine_nonproduct_sku_references [--dry-run | --apply]
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

from app.postgres_repository import PostgresSettings


import os

ROOT = Path(__file__).resolve().parents[2]
REPORT_DIR = ROOT / "plans" / "2026-09-09-media-asset-sku-decoupling" / "reports"


def _ensure_env() -> None:
    if "DATABASE_URL" not in os.environ:
        for env_path in (ROOT / "backend" / ".env", ROOT / ".env.local"):
            if env_path.is_file():
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("'\"")
                        if k not in os.environ:
                            os.environ[k] = v


def run_quarantine(apply: bool = False, database_url: str | None = None) -> dict[str, Any]:
    _ensure_env()
    dsn = database_url or os.environ.get("DATABASE_URL")
    if not dsn:
        try:
            dsn = PostgresSettings.from_environment().database_url
        except Exception:
            raise SystemExit("DATABASE_URL is not set. Provide it via environment variable or --database-url.")
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # 1. Inspect total pool before quarantine
            cur.execute("""
                select count(*)::int as total,
                       count(*) filter (where match_eligible)::int as match_eligible,
                       count(*) filter (where is_frozen_benchmark)::int as frozen_benchmark
                from public.sku_references
            """)
            baseline_counts = dict(cur.fetchone() or {})

            # 2. Find eligible quarantine candidates
            query_candidates = """
                select r.id as reference_id,
                       r.sku,
                       r.reference_role as current_role,
                       r.match_eligible as current_match_eligible,
                       a.id as media_asset_id,
                       a.category,
                       coalesce((a.ai_flags->>'has_people')::boolean, false) as has_people,
                       coalesce((a.ai_confidence->>'sku')::numeric, 0) as sku_confidence,
                       case
                         when lower(trim(coalesce(a.category, ''))) = 'banner' then 'BANNER'
                         when lower(trim(coalesce(a.category, ''))) in ('công trình', 'cong trinh') then 'INSTALLATION'
                         when lower(trim(coalesce(a.category, ''))) in ('bảo hành', 'bao hanh') then 'REAL_WORLD'
                         when lower(trim(coalesce(a.category, ''))) = 'showroom' then 'LIFESTYLE'
                         else 'UNCLASSIFIED'
                       end as target_role
                from public.sku_references r
                join public.media_assets a on a.id = r.source_media_asset_id
                where r.is_active = true
                  and r.match_eligible = true
                  and r.is_frozen_benchmark = false
                  and r.reference_role = 'UNCLASSIFIED'
                  and (
                    a.category is distinct from 'Studio'
                    or coalesce((a.ai_flags->>'has_people')::boolean, false)
                    or coalesce((a.ai_confidence->>'sku')::numeric, 0) < 80
                  )
                order by r.created_at desc
            """
            cur.execute(query_candidates)
            candidates = [dict(row) for row in cur.fetchall()]

            # Group candidates by target_role and category for report
            by_target_role: dict[str, int] = {}
            by_category: dict[str, int] = {}
            for c in candidates:
                role = c["target_role"]
                cat = c["category"] or "Unknown"
                by_target_role[role] = by_target_role.get(role, 0) + 1
                by_category[cat] = by_category.get(cat, 0) + 1

            updated_count = 0
            if apply and candidates:
                cur.execute("""
                    update public.sku_references r
                       set match_eligible  = false,
                           reference_role  = case
                             when lower(trim(coalesce(a.category, ''))) = 'banner' then 'BANNER'
                             when lower(trim(coalesce(a.category, ''))) in ('công trình', 'cong trinh') then 'INSTALLATION'
                             when lower(trim(coalesce(a.category, ''))) in ('bảo hành', 'bao hanh') then 'REAL_WORLD'
                             when lower(trim(coalesce(a.category, ''))) = 'showroom' then 'LIFESTYLE'
                             else 'UNCLASSIFIED'
                           end,
                           curation_status = 'UNREVIEWED',
                           updated_at      = now()
                      from public.media_assets a
                     where a.id = r.source_media_asset_id
                       and r.is_active           = true
                       and r.match_eligible      = true
                       and r.is_frozen_benchmark = false
                       and r.reference_role      = 'UNCLASSIFIED'
                       and (
                         a.category is distinct from 'Studio'
                         or coalesce((a.ai_flags->>'has_people')::boolean, false)
                         or coalesce((a.ai_confidence->>'sku')::numeric, 0) < 80
                       )
                """)
                updated_count = cur.rowcount
                conn.commit()

            # 3. Post-check counts
            cur.execute("""
                select count(*)::int as total,
                       count(*) filter (where match_eligible)::int as match_eligible,
                       count(*) filter (where is_frozen_benchmark)::int as frozen_benchmark
                from public.sku_references
            """)
            post_counts = dict(cur.fetchone() or {})

            report: dict[str, Any] = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "mode": "apply" if apply else "dry-run",
                "baseline_counts": baseline_counts,
                "quarantine_candidates_count": len(candidates),
                "rows_updated": updated_count,
                "by_target_role": by_target_role,
                "by_category": by_category,
                "sample_candidates": candidates[:10],
                "post_counts": post_counts,
            }

            REPORT_DIR.mkdir(parents=True, exist_ok=True)
            report_file = REPORT_DIR / ("quarantine-apply.json" if apply else "quarantine-dry-run.json")
            with open(report_file, "w", encoding="utf-8") as f:
                json.dump(report, f, indent=2, ensure_ascii=False, default=str)

            return report
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Quarantine non-product SKU references.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", default=True, help="Scan and report without writing (default)")
    group.add_argument("--apply", action="store_true", help="Execute quarantine and commit changes")
    parser.add_argument("--database-url", type=str, default=None, help="PostgreSQL connection string override")
    args = parser.parse_args()

    apply = bool(args.apply)
    print(f"Running quarantine (mode={'APPLY' if apply else 'DRY-RUN'})...")
    report = run_quarantine(apply=apply, database_url=args.database_url)
    print(f"Candidates found: {report['quarantine_candidates_count']}")
    if apply:
        print(f"Rows updated: {report['rows_updated']}")
    print(f"Breakdown by target role: {report['by_target_role']}")
    print(f"Breakdown by category: {report['by_category']}")
    print(f"Report written to reports directory.")


if __name__ == "__main__":
    main()
