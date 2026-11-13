"""
Backfill Missing Descriptions for Ingested Media Assets.
Finds assets in Postgres with empty descriptions, downloads their WebP from R2,
calls AI Vision to extract the rich 4-6 sentence technical description,
and updates media_assets.description.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for p in (str(PROJECT_ROOT), str(BACKEND_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

import requests
from backend.importers.google_drive.orchestrator import extract_local_vision_metadata, convert_image_to_webp

VPS_HOST = "root@203.0.113.10"
SSH_KEY_PATH = Path.home() / ".ssh" / "verity_vps_deploy_ed25519"


def get_assets_needing_description(limit: int | None = None) -> list[dict[str, Any]]:
    import subprocess
    import json

    sql = """
        SELECT json_agg(t) FROM (
            SELECT id, title, sku, brand, space, storage_path, file_url, suggested_caption
            FROM public.media_assets
            WHERE (description IS NULL OR trim(description) = '')
              AND deleted_at IS NULL
            ORDER BY created_at DESC
        ) t;
    """
    cmd = [
        "ssh", "-i", str(SSH_KEY_PATH), VPS_HOST,
        f'docker exec verity_native_media_db psql -U verity verity_media -t -A -c "{sql}"'
    ]
    proc = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    raw = proc.stdout.strip()
    if not raw or raw == "null":
        return []
    data = json.loads(raw)
    return data[:limit] if limit else data


def update_asset_description_on_vps(asset_id: str, description: str):
    import subprocess

    # Escape single quotes in description for SQL literal
    clean_desc = description.replace("'", "''")
    sql = f"UPDATE public.media_assets SET description = '{clean_desc}', updated_at = now() WHERE id = '{asset_id}';\n"
    cmd = [
        "ssh", "-i", str(SSH_KEY_PATH), VPS_HOST,
        "docker exec -i verity_native_media_db psql -U verity verity_media"
    ]
    proc = subprocess.run(cmd, input=sql, capture_output=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to update description for {asset_id}: {proc.stderr}")


def run_backfill(limit: int | None = None, dry_run: bool = False):
    assets = get_assets_needing_description(limit=limit)
    total = len(assets)
    print("=" * 70)
    print(f"BACKFILL MISSING DESCRIPTIONS ({total} ASSETS)")
    print(f"Dry run: {dry_run} | Limit: {limit}")
    print("=" * 70 + "\n")

    if not assets:
        print("No assets found needing description. All clean!")
        return

    success_count = 0
    error_count = 0

    for idx, a in enumerate(assets, 1):
        asset_id = a["id"]
        title = a.get("title", "")
        sku = a.get("sku", "")
        file_url = a.get("file_url", "")
        caption = a.get("suggested_caption", "")

        print(f"[{idx}/{total}] Processing {sku} | {asset_id}")
        print(f"  Title: {title}")

        try:
            # Download image bytes from R2 CDN URL
            resp = requests.get(file_url, timeout=20)
            if not resp.ok:
                raise RuntimeError(f"HTTP {resp.status_code} downloading {file_url}")
            img_bytes = resp.content

            # Convert to WebP if not already
            if not file_url.endswith(".webp"):
                webp_bytes, _, _ = convert_image_to_webp(img_bytes)
            else:
                webp_bytes = img_bytes

            # Call AI Vision
            hint = f"Khóa thông minh {sku} - {title}"
            meta = extract_local_vision_metadata(
                image_bytes=webp_bytes,
                mime_type="image/webp",
                batch_context=hint,
            )

            desc = (meta.get("description") or "").strip()
            if not desc or len(desc) < 60 or desc.lower() == (caption or "").lower():
                raise ValueError(f"Vision model did not return a valid rich description (len={len(desc)})")

            print(f"  Generated Description ({len(desc)} chars): {desc[:100]}...")

            if not dry_run:
                update_asset_description_on_vps(asset_id, desc)
                print("  -> UPDATED on VPS!")
            else:
                print("  -> [dry-run] Skipped VPS update")

            success_count += 1
            time.sleep(1.0)

        except Exception as e:
            print(f"  [ERROR] {e}")
            error_count += 1

    print("\n" + "=" * 70)
    print("BACKFILL SUMMARY")
    print(f"Total: {total} | Success: {success_count} | Errors: {error_count}")
    print("=" * 70)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill missing descriptions for media assets")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of assets to process")
    parser.add_argument("--dry-run", action="store_true", help="Run without updating DB")
    args = parser.parse_args()

    run_backfill(limit=args.limit, dry_run=args.dry_run)
