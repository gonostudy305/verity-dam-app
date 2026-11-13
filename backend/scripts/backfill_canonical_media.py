"""Queue and audit the Universal Canonical Media Pipeline.

This runner never renames or deletes an original R2 object.  It only queues
``publish_canonical_media`` jobs; the worker uploads immutable WebP
derivatives and swaps the CDN pointer after every rendition succeeds.

Usage:
  python -m scripts.backfill_canonical_media --dry-run
  python -m scripts.backfill_canonical_media --confirm --wait
  python -m scripts.backfill_canonical_media --audit-only
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CANONICAL_PREFIX = "wp-content/uploads/"
IMAGE_MEDIA_TYPES = ("photo", "render", "screenshot")


@dataclass(frozen=True)
class CanonicalMediaAudit:
    checked_at: str
    total_eligible: int
    canonical_ready: int
    pending: int
    failed_jobs: int
    invalid_canonical_urls: int

    @property
    def passed(self) -> bool:
        return self.pending == 0 and self.failed_jobs == 0 and self.invalid_canonical_urls == 0

    @property
    def status(self) -> str:
        return "PASS" if self.passed else "PENDING" if self.failed_jobs == 0 else "FAIL"


class CanonicalMediaBackfill:
    def __init__(self, repository: Any) -> None:
        self.repository = repository

    def queue_missing(self, *, dry_run: bool, limit: int | None = None) -> dict[str, int]:
        query = """
            select a.id, a.canonical_version
            from public.media_assets a
            where a.deleted_at is null
              and a.media_type = any(%s::text[])
              and a.ingest_status = 'ready'
              and coalesce(a.storage_path, '') <> ''
              and (
                coalesce(a.canonical_published_version, 0) < a.canonical_version
                or coalesce(a.cdn_key, '') not like %s
              )
            order by a.created_at asc
        """
        params: list[Any] = [list(IMAGE_MEDIA_TYPES), f"{CANONICAL_PREFIX}%"]
        if limit is not None:
            query += " limit %s"
            params.append(max(1, int(limit)))
        rows = self.repository.fetch_all(query, tuple(params))
        queued = 0
        if dry_run:
            return {"candidates": len(rows), "queued": 0}
        with self.repository.transaction() as cursor:
            for row in rows:
                asset_id = str(row["id"] if isinstance(row, dict) else row[0])
                version = int(row["canonical_version"] if isinstance(row, dict) else row[1])
                cursor.execute(
                    """
                    insert into public.media_ingest_jobs (media_asset_id, job_kind, idempotency_key, payload)
                    values (%s, 'publish_canonical_media', %s, jsonb_build_object('canonical_version', %s))
                    on conflict (idempotency_key) do nothing
                    """,
                    (asset_id, f"publish_canonical_media:{asset_id}:{version}", version),
                )
                queued += max(0, int(getattr(cursor, "rowcount", 0) or 0))
        return {"candidates": len(rows), "queued": queued}

    def audit(self) -> CanonicalMediaAudit:
        row = self.repository.fetch_one(
            """
            select
              count(*) filter (where a.deleted_at is null and a.media_type = any(%s::text[]) and a.ingest_status = 'ready')::int as total_eligible,
              count(*) filter (
                where a.deleted_at is null and a.media_type = any(%s::text[]) and a.ingest_status = 'ready'
                  and coalesce(a.cdn_key, '') like %s
                  and coalesce(a.cdn_url, '') like 'https://%%'
                  and a.canonical_published_version = a.canonical_version
                  and coalesce(a.canonical_slug, '') <> ''
              )::int as canonical_ready,
              count(*) filter (
                where a.deleted_at is null and a.media_type = any(%s::text[]) and a.ingest_status = 'ready'
                  and not (
                    coalesce(a.cdn_key, '') like %s
                    and coalesce(a.cdn_url, '') like 'https://%%'
                    and a.canonical_published_version = a.canonical_version
                    and coalesce(a.canonical_slug, '') <> ''
                  )
              )::int as pending,
              count(*) filter (
                where a.deleted_at is null and a.media_type = any(%s::text[]) and a.ingest_status = 'ready'
                  and (coalesce(a.cdn_key, '') like %s)
                  and (
                    coalesce(a.cdn_url, '') not like 'https://%%'
                    or coalesce(a.canonical_slug, '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
                  )
              )::int as invalid_canonical_urls
            from public.media_assets a
            """,
            (
                list(IMAGE_MEDIA_TYPES), list(IMAGE_MEDIA_TYPES), f"{CANONICAL_PREFIX}%",
                list(IMAGE_MEDIA_TYPES), f"{CANONICAL_PREFIX}%",
                list(IMAGE_MEDIA_TYPES), f"{CANONICAL_PREFIX}%",
            ),
        ) or {}
        failed = self.repository.fetch_one(
            """
            select count(*)::int as count
            from public.media_ingest_jobs
            where job_kind = 'publish_canonical_media' and status = 'failed'
            """
        ) or {}
        return CanonicalMediaAudit(
            checked_at=datetime.now(timezone.utc).isoformat(),
            total_eligible=int(row.get("total_eligible", 0)),
            canonical_ready=int(row.get("canonical_ready", 0)),
            pending=int(row.get("pending", 0)),
            failed_jobs=int(failed.get("count", 0)),
            invalid_canonical_urls=int(row.get("invalid_canonical_urls", 0)),
        )

    def wait_until_complete(self, timeout_seconds: int, poll_seconds: float = 2.0) -> CanonicalMediaAudit:
        deadline = time.monotonic() + max(1, timeout_seconds)
        while True:
            report = self.audit()
            if report.passed or time.monotonic() >= deadline:
                return report
            time.sleep(max(0.25, poll_seconds))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill universal canonical WebP renditions")
    parser.add_argument("--confirm", action="store_true", help="Queue canonical publication jobs (default is dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="Report candidates without inserting jobs")
    parser.add_argument("--audit-only", action="store_true", help="Check CDN pointers and job state only")
    parser.add_argument("--limit", type=int, default=None, help="Maximum assets to queue")
    parser.add_argument("--wait", action="store_true", help="Wait for the worker to finish all canonical jobs")
    parser.add_argument("--timeout-seconds", type=int, default=1800, help="Maximum wait time when --wait is supplied")
    parser.add_argument("--output-report", default="canonical_media_audit.json", help="JSON report destination")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    from app.native_gateway import NativeGateway
    from app.production_config import WorkerSettings

    gateway = NativeGateway(WorkerSettings.from_environment())
    runner = CanonicalMediaBackfill(gateway.repository)
    if args.audit_only:
        report = runner.audit()
    else:
        result = runner.queue_missing(dry_run=not args.confirm or args.dry_run, limit=args.limit)
        print(json.dumps(result, ensure_ascii=False))
        report = runner.wait_until_complete(args.timeout_seconds) if args.wait and args.confirm and not args.dry_run else runner.audit()
    payload = {**asdict(report), "status": report.status}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    Path(args.output_report).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
