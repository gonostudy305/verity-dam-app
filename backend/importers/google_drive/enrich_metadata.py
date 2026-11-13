"""
Enrich & Backfill AI Metadata for Existing Production Assets.
Fetches all assets requiring enrichment:
- Missing or empty description
- Caption under 60 characters
- Empty or minimal keywords (< 3 tags)

Runs multi-model AI vision with high detail, downloads images from CDN,
and updates Postgres safely.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path
import requests

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for p in (str(PROJECT_ROOT), str(BACKEND_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

from backend.importers.google_drive.orchestrator import (
    extract_local_vision_metadata,
    SSH_KEY_PATH,
    VPS_HOST,
)

MEDIA_BASE_URL = "https://assets.verity.internal"
CHECKPOINT_FILE = BACKEND_ROOT / "importers" / "google_drive" / "enrich_checkpoint.json"


def load_checkpoint() -> set[str]:
    if CHECKPOINT_FILE.exists():
        try:
            with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return set(data.get("completed_ids", []))
        except Exception as e:
            print(f"[warn] Could not load checkpoint: {e}")
    return set()


def save_checkpoint(completed_ids: set[str]):
    try:
        with open(CHECKPOINT_FILE, "w", encoding="utf-8") as f:
            json.dump({"completed_ids": sorted(list(completed_ids))}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[warn] Could not save checkpoint: {e}")


def fetch_assets_to_enrich(scope: str = "all", sku: str | None = None, limit: int | None = None) -> list[dict]:
    """Fetch all assets requiring metadata enrichment via JSON aggregation."""
    clauses = ["deleted_at IS NULL"]
    
    if scope == "phase1":
        clauses.append("sku IN ('Verity N1', 'Verity C02', 'Verity A1', 'Verity NT01', 'Khóa Melo 301', 'Khoá SL210', 'Khoá SL108')")
    elif sku:
        clauses.append(f"sku = '{sku}'")

    clauses.append("""(
        description IS NULL OR description = ''
        OR length(suggested_caption) < 60
        OR keywords IS NULL OR array_length(keywords, 1) IS NULL OR array_length(keywords, 1) < 3
    )""")

    where_sql = " AND ".join(clauses)
    limit_sql = f" LIMIT {limit}" if limit else ""

    query = f"""
    SELECT json_agg(row_to_json(t))
    FROM (
        SELECT id, sku, brand, category, title, storage_path, file_url, suggested_caption, description, keywords
        FROM media_assets
        WHERE {where_sql}
        ORDER BY created_at DESC
        {limit_sql}
    ) t;
    """

    cmd = [
        "ssh", "-o", "BatchMode=yes", "-i", str(SSH_KEY_PATH), VPS_HOST,
        f'docker exec verity_native_media_db psql -U verity -d verity_media -t -A -c "{query}"'
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    out = proc.stdout.strip()
    if not out or out == "null":
        return []
    try:
        return json.loads(out)
    except Exception as e:
        print(f"[error] Failed to parse assets JSON: {e}\nRaw output: {out[:300]}")
        return []


def update_asset_in_db_safe(asset_id: str, caption: str, description: str, keywords: list[str]):
    """Safely update metadata in Postgres using a json-driven command to avoid shell escaping issues."""
    payload = json.dumps({
        "id": asset_id,
        "caption": caption,
        "description": description,
        "keywords": keywords,
    })

    python_code = f"""
import json, psycopg2, os
data = json.loads('''{payload}''')
conn = psycopg2.connect(os.environ['DATABASE_URL'])
with conn.cursor() as cur:
    cur.execute('''
        UPDATE media_assets
        SET suggested_caption = %s,
            description = %s,
            keywords = %s,
            updated_at = NOW()
        WHERE id = %s;
    ''', (data['caption'], data['description'], data['keywords'], data['id']))
    conn.commit()
conn.close()
"""
    cmd = [
        "ssh", "-o", "BatchMode=yes", "-i", str(SSH_KEY_PATH), VPS_HOST,
        "docker exec -i verity_native_media_mcp python -c " + json.dumps(python_code)
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)


def run_enrichment(scope: str = "all", sku: str | None = None, limit: int | None = None, dry_run: bool = False):
    completed_ids = load_checkpoint()
    assets = fetch_assets_to_enrich(scope=scope, sku=sku, limit=limit)
    
    # Filter out already completed
    pending_assets = [a for a in assets if a["id"] not in completed_ids]
    print(f"\n========================================================")
    print(f"Enrichment Target: {len(assets)} total matching assets.")
    print(f"Already completed in checkpoint: {len(assets) - len(pending_assets)}")
    print(f"Pending to process: {len(pending_assets)}")
    print(f"========================================================\n")

    if not pending_assets:
        print("No pending assets need enrichment!")
        return

    success_count = 0
    fail_count = 0

    for idx, item in enumerate(pending_assets, 1):
        a_id = item["id"]
        sku_val = item.get("sku") or ""
        brand_val = item.get("brand") or "Verity"
        cat_val = item.get("category") or "Khóa thông minh"
        storage_path = item.get("storage_path") or item.get("file_url")

        if storage_path.startswith("http"):
            img_url = storage_path
        else:
            img_url = f"{MEDIA_BASE_URL}/{storage_path.lstrip('/')}"

        print(f"[{idx}/{len(pending_assets)}] Asset {a_id} (SKU: '{sku_val}' | Cat: '{cat_val}')...")

        batch_ctx = f"{brand_val} {sku_val} {cat_val}".strip()
        if not batch_ctx:
            batch_ctx = "Thiết bị gia dụng VerityDAM Platform"

        try:
            resp = requests.get(img_url, timeout=30)
            if not resp.ok:
                print(f"  [warn] Download failed for {img_url} (HTTP {resp.status_code})")
                fail_count += 1
                continue

            content_type = resp.headers.get("Content-Type", "image/webp")
            if "jpeg" in content_type or img_url.endswith((".jpg", ".jpeg")):
                mime_type = "image/jpeg"
            elif "png" in content_type or img_url.endswith(".png"):
                mime_type = "image/png"
            else:
                mime_type = "image/webp"

            meta = extract_local_vision_metadata(
                resp.content,
                mime_type=mime_type,
                batch_context=batch_ctx,
                image_detail="high",
            )

            caption = (meta.get("caption") or "").strip()
            description = (meta.get("description") or "").strip()
            keywords = meta.get("keywords") or []

            # If description missing, fallback to caption
            if not description:
                description = caption
            # If existing caption was already long (>100 chars) and new caption is short, preserve the better one
            old_caption = (item.get("suggested_caption") or "").strip()
            if len(old_caption) > 100 and len(caption) < 60:
                caption = old_caption

            if dry_run:
                print(f"  [DRY-RUN] Would update ID {a_id}:")
                print(f"    Caption: {caption}")
                print(f"    Description: {description[:120]}...")
                print(f"    Keywords: {keywords}")
            else:
                update_asset_in_db_safe(a_id, caption, description, keywords)
                completed_ids.add(a_id)
                save_checkpoint(completed_ids)
                success_count += 1
                print(f"  -> SUCCESS! Description: {description[:80]}...")

            time.sleep(1.0)  # Gentle rate limiting

        except Exception as e:
            print(f"  [error] Enrichment failed for {a_id}: {e}")
            fail_count += 1
            time.sleep(2.0)

    print(f"\n========================================================")
    print(f"Enrichment Pass Complete!")
    print(f"Success: {success_count} | Failed: {fail_count}")
    print(f"Total Completed in Checkpoint: {len(completed_ids)}")
    print(f"========================================================\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Enrich media assets with high-detail vision metadata")
    parser.add_argument("--scope", choices=["all", "phase1"], default="all", help="Target scope (all vs phase1)")
    parser.add_argument("--sku", type=str, default=None, help="Target specific SKU")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of assets to process")
    parser.add_argument("--dry-run", action="store_true", help="Run without DB updates")
    args = parser.parse_args()

    run_enrichment(scope=args.scope, sku=args.sku, limit=args.limit, dry_run=args.dry_run)
