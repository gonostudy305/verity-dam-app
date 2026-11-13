"""
AI Vision Enrichment Script for Curated Ingested Media Assets.

Loads assets from Postgres, calls the configured AI Vision provider with the
production system prompt, taxonomy and batch context, and updates
media_assets / media_asset_products.

Re-runnable by design:
  * Each run is recorded in public.media_tagging_runs (tagger 'metadata_vision',
    prompt_version, model, output + snapshot of the previous values), in the
    same transaction as the asset update. Failures are recorded too.
  * By default an asset that already has a succeeded run at the current
    PROMPT_VERSION is skipped, so an interrupted batch resumes by re-running
    the same command and a prompt bump re-processes only what is stale.
    Use --force to re-process anyway.
  * --dry-run calls the vision provider but writes nothing to the database;
    combine with --report to review before/after diffs as JSONL.
  * --rollback restores the values saved before the latest enrichment run at
    the current PROMPT_VERSION for the targeted assets (no vision calls).
    Assets edited after that run are skipped unless --force.
  * Product links are only confirmed with --confirm-products.

Note: any metadata change (enrich or rollback) bumps canonical_version via
trg_bump_media_asset_canonical_version, which may enqueue republish jobs.
"""

from __future__ import annotations

import concurrent.futures
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

if "/app" not in sys.path:
    sys.path.insert(0, "/app")

from app.native_gateway import NativeGateway
from app.production_config import WorkerSettings
from app.shared_vision_config import apply_shared_vision_config
from app.vision_metadata import PROMPT_VERSION, call_vision_metadata

TAGGER = "metadata_vision"
_MIME_MAP = {
    "webp": "image/webp",
    "png": "image/png",
    "heic": "image/heic",
    "heif": "image/heif",
    "gif": "image/gif",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}


def snapshot(asset: dict[str, Any]) -> dict[str, Any]:
    """Enrichable fields of an asset, used for audit and manual rollback."""
    flags = asset.get("ai_flags") or {}
    return {
        "title": asset.get("title"),
        "caption": asset.get("suggested_caption"),
        "description": asset.get("description"),
        "keywords": asset.get("keywords"),
        "visible_text": asset.get("visible_text"),
        "category": asset.get("category"),
        "space": asset.get("space"),
        "status": asset.get("status"),
        "has_people": flags.get("has_people") if isinstance(flags, dict) else None,
        "shot_type": flags.get("shot_type") if isinstance(flags, dict) else None,
        "ai_confidence": asset.get("ai_confidence"),
    }


def _record_run(cursor: Any, asset_id: str, status: str, model: str | None, output: dict[str, Any], error: str | None) -> None:
    cursor.execute(
        "insert into public.media_tagging_runs (media_asset_id, tagger, status, model, prompt_version, output, error_message) "
        f"values (%s, '{TAGGER}', %s, %s, %s, %s::jsonb, %s)",
        (asset_id, status, model, PROMPT_VERSION, json.dumps(output, ensure_ascii=False, default=str), error),
    )


def enrich_asset(
    asset_id: str,
    gateway: NativeGateway,
    vision_settings: Any,
    examples: list[dict[str, Any]],
    taxonomy_options: list[dict[str, Any]],
    batch_context: str,
    dry_run: bool = False,
    confirm_products: bool = False,
) -> dict[str, Any]:
    asset = gateway.get_media_asset(asset_id)
    if not asset:
        raise ValueError(f"Asset not found: {asset_id}")

    storage_path = asset["storage_path"]
    ext = storage_path.lower().split(".")[-1] if "." in storage_path else ""
    mime_type = _MIME_MAP.get(ext, "image/jpeg")
    model = getattr(vision_settings, "vision_model", None)
    before = snapshot(asset)

    last_err: Exception | None = None
    res = None
    try:
        raw_source = gateway.download_object(storage_path)
        source = raw_source
        try:
            from app.image_processing import vision_rendition
            source, mime_type = vision_rendition(raw_source)
        except Exception:
            pass
        for attempt in range(3):
            try:
                res = call_vision_metadata(
                    vision_settings,
                    source,
                    mime_type,
                    examples,
                    taxonomy_options=taxonomy_options,
                    batch_context=batch_context,
                )
                break
            except Exception as err:
                last_err = err
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
        if res is None:
            raise last_err or RuntimeError("Vision call failed without response")
    except Exception as err:
        if not dry_run:
            with gateway.repository.transaction() as cursor:
                _record_run(cursor, asset_id, "failed", model,
                            {"_enrich": {"previous": before, "batch_context": batch_context}},
                            f"{type(err).__name__}: {err}"[:2000])
        raise

    caption = res.get("caption")
    description = res.get("description")
    keywords = res.get("keywords", [])
    visible_text = res.get("visible_text", [])
    category = res.get("category")
    space = res.get("space")
    status = res.get("status")
    has_people = res.get("has_people", False)
    shot_type = res.get("shot_type")
    confidence = {k: v for k, v in res.items() if k.endswith("_confidence")}

    from app.image_processing import compose_canonical_title, is_generic_or_raw_title
    curr_title = asset.get("title", "")
    new_title = curr_title
    if is_generic_or_raw_title(curr_title):
        enriched_asset = {
            **asset,
            "suggested_caption": caption or asset.get("suggested_caption"),
            "category": category or asset.get("category"),
            "space": space or asset.get("space"),
        }
        composed = compose_canonical_title(enriched_asset)
        if composed and not is_generic_or_raw_title(composed):
            new_title = composed

    after = {
        "title": new_title,
        "caption": caption,
        "description": description,
        "keywords": keywords,
        "visible_text": visible_text,
        "category": category,
        "space": space,
        "status": status,
        "has_people": has_people,
        "shot_type": shot_type,
    }
    record = {
        "asset_id": asset_id,
        "sku": asset.get("sku"),
        "storage_path": storage_path,
        "prompt_version": PROMPT_VERSION,
        "model": model,
        "status": "dry_run" if dry_run else "succeeded",
        "before": before,
        "after": after,
        "confidence": confidence,
    }
    if dry_run:
        return record

    with gateway.repository.transaction() as cursor:
        cursor.execute("""
            UPDATE public.media_assets
            SET title = coalesce(nullif(trim(%s), ''), title),
                suggested_caption = coalesce(nullif(trim(%s), ''), suggested_caption),
                description = coalesce(nullif(trim(%s), ''), description),
                keywords = case
                    when %s::text[] is not null and array_length(%s::text[], 1) > 0 then %s::text[]
                    else keywords
                end,
                visible_text = case
                    when %s::text[] is not null and array_length(%s::text[], 1) > 0 then %s::text[]
                    else visible_text
                end,
                category = coalesce(nullif(trim(%s), ''), category),
                space = coalesce(nullif(trim(%s), ''), space),
                status = coalesce(nullif(trim(%s), ''), status),
                ai_flags = coalesce(ai_flags, '{}'::jsonb) || jsonb_build_object('has_people', %s::boolean, 'shot_type', %s::text),
                ai_confidence = coalesce(ai_confidence, '{}'::jsonb) || %s::jsonb,
                updated_at = now()
            WHERE id = %s
        """, (new_title, caption, description, keywords, keywords, keywords, visible_text, visible_text, visible_text, category, space, status, has_people, shot_type, json.dumps(confidence), asset_id))

        if confirm_products:
            # Confirm product links only if asset is approved and free of duplicate flags
            cursor.execute("""
                UPDATE public.media_asset_products map
                SET review_state = 'confirmed'
                FROM public.media_assets a
                LEFT JOIN public.review_queue q ON q.media_asset_id = a.id
                WHERE map.media_asset_id = a.id
                  AND a.id = %s
                  AND a.review_state = 'approved'
                  AND coalesce((a.ai_flags->>'is_duplicate')::boolean, false) IS NOT TRUE
                  AND coalesce(a.status, '') <> 'duplicate'
                  AND (q.id IS NULL OR q.is_duplicate IS NOT TRUE)
            """, (asset_id,))

        _record_run(cursor, asset_id, "succeeded", model,
                    {**res, "_enrich": {"previous": before, "batch_context": batch_context}}, None)

    return record


def selection_query(mode: str, sku: str | None, force: bool) -> tuple[str, tuple[Any, ...]]:
    """Build the candidate query; skips assets already enriched at PROMPT_VERSION unless forced."""
    params: list[Any] = []
    if mode == "sku":
        where = "a.sku = %s AND a.deleted_at IS NULL"
        params.append(sku)
    elif mode == "missing_desc":
        where = ("(a.description IS NULL OR trim(a.description) = '') "
                 "AND a.deleted_at IS NULL AND a.ingest_status = 'ready'")
    elif mode == "all":
        where = "a.deleted_at IS NULL AND a.ingest_status = 'ready'"
    else:
        raise ValueError(f"unknown mode {mode!r}")
    if not force:
        where += f"""
              AND not exists (
                  SELECT 1 FROM public.media_tagging_runs r
                  WHERE r.media_asset_id = a.id
                    AND r.tagger = '{TAGGER}'
                    AND r.status = 'succeeded'
                    AND r.prompt_version = %s
              )"""
        params.append(PROMPT_VERSION)
    query = f"""
            SELECT a.id, a.title, a.storage_path, a.sku, a.brand
            FROM public.media_assets a
            WHERE {where}
            ORDER BY a.created_at ASC
        """
    return query, tuple(params)


def rollback_query(mode: str, sku: str | None) -> tuple[str, tuple[Any, ...]]:
    """Latest enrichment run (with a saved snapshot) per targeted asset at PROMPT_VERSION."""
    params: list[Any] = [PROMPT_VERSION]
    if mode == "sku":
        target = "a.sku = %s"
        params.append(sku)
    elif mode == "all":
        target = "a.deleted_at IS NULL"
    else:
        raise ValueError(f"rollback does not support mode {mode!r}")
    query = f"""
            SELECT DISTINCT ON (r.media_asset_id)
                   r.id AS run_id, r.media_asset_id AS asset_id, r.output, a.sku, a.title,
                   (a.updated_at > r.created_at) AS changed_after
            FROM public.media_tagging_runs r
            JOIN public.media_assets a ON a.id = r.media_asset_id
            WHERE r.tagger = '{TAGGER}'
              AND r.status = 'succeeded'
              AND r.prompt_version = %s
              AND r.output -> '_enrich' -> 'previous' IS NOT NULL
              AND {target}
            ORDER BY r.media_asset_id, r.created_at DESC
        """
    return query, tuple(params)


def rollback_run(gateway: Any, run: dict[str, Any], dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    """Restore an asset to the snapshot saved before an enrichment run."""
    output = run.get("output") or {}
    if isinstance(output, str):
        output = json.loads(output)
    previous = (output.get("_enrich") or {}).get("previous")
    base = {"asset_id": str(run["asset_id"]), "sku": run.get("sku"), "run_id": str(run["run_id"]),
            "prompt_version": PROMPT_VERSION}
    if not isinstance(previous, dict):
        return {**base, "status": "skipped", "reason": "run has no saved snapshot"}
    if run.get("changed_after") and not force:
        return {**base, "status": "skipped", "reason": "asset edited after the enrichment run (use --force)"}
    if dry_run:
        return {**base, "status": "dry_run_rollback", "restore": previous}

    has_confidence = isinstance(previous.get("ai_confidence"), dict)
    with gateway.repository.transaction() as cursor:
        cursor.execute("""
            UPDATE public.media_assets
            SET title = coalesce(%s, title),
                suggested_caption = %s,
                description = coalesce(%s, ''),
                keywords = coalesce(%s::text[], '{}'),
                visible_text = %s::text[],
                category = %s,
                space = %s,
                status = coalesce(%s, status),
                ai_flags = (coalesce(ai_flags, '{}'::jsonb) - 'shot_type')
                    || jsonb_build_object('has_people', coalesce(%s::boolean, false))
                    || case when %s::text is null then '{}'::jsonb else jsonb_build_object('shot_type', %s::text) end,
                ai_confidence = case when %s then %s::jsonb else ai_confidence end,
                updated_at = now()
            WHERE id = %s
        """, (
            previous.get("title"), previous.get("caption"), previous.get("description"),
            previous.get("keywords"), previous.get("visible_text"), previous.get("category"),
            previous.get("space"), previous.get("status"), previous.get("has_people"),
            previous.get("shot_type"), previous.get("shot_type"),
            has_confidence, json.dumps(previous.get("ai_confidence") if has_confidence else {}),
            base["asset_id"],
        ))
        cursor.execute(
            "UPDATE public.media_tagging_runs SET status = 'rolled_back' WHERE id = %s",
            (base["run_id"],),
        )
        _record_run(cursor, base["asset_id"], "rollback", None,
                    {"_rollback_of": base["run_id"], "restored": previous}, None)
    return {**base, "status": "rolled_back", "restore": previous}


def _run_rollback(args: Any, gateway: Any, mode: str) -> int:
    query, params = rollback_query(mode, args.sku)
    runs = gateway.repository.fetch_all(query, params)
    if args.limit:
        runs = runs[:args.limit]
    print(f"Found {len(runs)} enrichment runs at {PROMPT_VERSION} to roll back"
          f"{' [DRY RUN - no DB writes]' if args.dry_run else ''}\n")
    counts: dict[str, int] = {}
    report_file = args.report.open("a", encoding="utf-8") if args.report else None
    try:
        for idx, run in enumerate(runs, 1):
            try:
                record = rollback_run(gateway, run, dry_run=args.dry_run, force=args.force)
            except Exception as e:
                record = {"asset_id": str(run.get("asset_id")), "run_id": str(run.get("run_id")),
                          "status": "failed", "error": f"{type(e).__name__}: {e}"}
            counts[record["status"]] = counts.get(record["status"], 0) + 1
            if report_file:
                report_file.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
            print(f"[{idx}/{len(runs)}] {record['status'].upper()} | {run.get('sku')} {run.get('title')}"
                  + (f" | {record.get('reason') or record.get('error')}" if record["status"] in ("skipped", "failed") else ""))
    finally:
        if report_file:
            report_file.close()
    print(f"\n{'='*60}\nROLLBACK COMPLETED: {counts}\n{'='*60}")
    return 1 if counts.get("failed") else 0


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Enrich media assets with production AI Vision")
    targets = parser.add_mutually_exclusive_group(required=True)
    targets.add_argument("--all", action="store_true", help="Process all ready media assets")
    targets.add_argument("--sku", type=str, help="Target SKU to enrich")
    targets.add_argument("--missing-desc-only", action="store_true", help="Process only assets with missing/empty description")
    parser.add_argument("--force", action="store_true",
                        help=f"Re-process assets already enriched at the current prompt version ({PROMPT_VERSION})")
    parser.add_argument("--dry-run", action="store_true", help="Call vision (or plan a rollback) but write nothing to the database")
    parser.add_argument("--rollback", action="store_true",
                        help="Restore pre-enrichment values for the targeted assets (latest run at the current prompt version)")
    parser.add_argument("--confirm-products", action="store_true",
                        help="Also confirm media_asset_products links for approved, non-duplicate assets")
    parser.add_argument("--report", type=Path, default=None, help="Write one JSONL record (before/after) per asset")
    parser.add_argument("--batch-context", type=str, default="", help="Optional batch context hint")
    parser.add_argument("--workers", type=int, default=3, help="Concurrent vision API workers")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of assets")
    args = parser.parse_args()
    mode = "all" if args.all else "missing_desc" if args.missing_desc_only else "sku"
    if args.rollback and mode == "missing_desc":
        parser.error("--rollback works with --sku or --all")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)

    settings = WorkerSettings.from_environment()
    gateway = NativeGateway(settings)
    if args.rollback:
        return _run_rollback(args, gateway, mode)

    vision_settings = apply_shared_vision_config(settings, gateway.shared_vision_config())

    examples = gateway.metadata_examples()
    taxonomy_options = gateway.taxonomy_options()

    label = {"all": "ALL READY ASSETS", "missing_desc": "MISSING DESCRIPTIONS ONLY", "sku": f"SKU = {args.sku}"}[mode]
    print(f"{'='*60}")
    print(f"AI VISION ENRICHMENT: {label}{' [DRY RUN - no DB writes]' if args.dry_run else ''}")
    print(f"Provider: {vision_settings.vision_base_url} | Model: {vision_settings.vision_model}")
    print(f"Prompt version: {PROMPT_VERSION} | {'re-process all (--force)' if args.force else 'skip assets already at this version'}")
    print(f"{'='*60}\n")

    query, params = selection_query(mode, args.sku, args.force)
    rows = gateway.repository.fetch_all(query, params)
    if args.limit:
        rows = rows[:args.limit]

    total = len(rows)
    print(f"Found {total} assets to process with {args.workers} workers...\n")

    report_lock = threading.Lock()
    report_file = None
    if args.report:
        report_file = args.report.open("a", encoding="utf-8")

    def _write_report(entry: dict[str, Any]) -> None:
        if report_file:
            with report_lock:
                report_file.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
                report_file.flush()

    start_time = time.time()
    success_count = 0
    error_count = 0

    def _process(item: dict[str, Any], index: int) -> dict[str, Any]:
        item_id = str(item["id"])
        item_title = item.get("title", "")
        t0 = time.time()
        batch_ctx = args.batch_context or " - ".join(
            str(value).strip() for value in (item.get("brand"), item_title) if value and str(value).strip()
        )
        res = enrich_asset(
            asset_id=item_id,
            gateway=gateway,
            vision_settings=vision_settings,
            examples=examples,
            taxonomy_options=taxonomy_options,
            batch_context=batch_ctx,
            dry_run=args.dry_run,
            confirm_products=args.confirm_products,
        )
        elapsed = time.time() - t0
        return {"index": index, "elapsed": elapsed, **res}

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            future_map = {
                executor.submit(_process, row, idx): row
                for idx, row in enumerate(rows, 1)
            }

            for future in concurrent.futures.as_completed(future_map):
                row = future_map[future]
                try:
                    res = future.result()
                    success_count += 1
                    _write_report({k: v for k, v in res.items() if k != "index"})
                    after = res["after"]
                    print(f"[{res['index']}/{total}] {res['status'].upper()} ({res['elapsed']:.1f}s) | {after['title']}")
                    print(f"   Caption:     {after['caption']}")
                    print(f"   Description: {str(after.get('description') or '')[:80]}...")
                    print(f"   Keywords:    {after['keywords']} | Shot: {after['shot_type']}")
                    print(f"   Taxonomy:    {after['category']} / {after['space']} / {after['status']}\n")
                except Exception as e:
                    error_count += 1
                    _write_report({"asset_id": str(row["id"]), "sku": row.get("sku"), "prompt_version": PROMPT_VERSION,
                                   "status": "failed", "error": f"{type(e).__name__}: {e}"})
                    print(f"[ERROR] Failed {row.get('title')}: {e}\n")
    finally:
        if report_file:
            report_file.close()

    total_elapsed = time.time() - start_time
    print(f"{'='*60}")
    print(f"ENRICHMENT COMPLETED in {total_elapsed:.1f}s")
    print(f"Success: {success_count} / {total} | Errors: {error_count}")
    if args.report:
        print(f"Report: {args.report}")
    print(f"{'='*60}")
    return 1 if error_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
