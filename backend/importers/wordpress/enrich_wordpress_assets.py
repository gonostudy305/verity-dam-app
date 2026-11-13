"""
WordPress Blog Media Enrichment & Taxonomy/SKU Mapping Engine.
Enriches the 121 WordPress blog media assets in Verity DAM with:
1. Real AI Vision captions & rich descriptions via Multi-Model VLM.
2. Canonical taxonomy mapping:
   - category: 'Ảnh thực tế' | 'Ảnh Studio' | 'Ảnh Thiết kế'
   - sub_category: 'Banner' | 'Hiện trường' | 'Công trình' | 'Sản phẩm chính'
   - space: 'Ngoài trời / Cổng' | 'Cửa chính' | 'Phòng khách' | 'Bếp' | 'Phòng ngủ' | 'Toàn cảnh'
   - status: 'Đã bàn giao' | 'Đang lắp' | 'Mới'
3. Remote SKU candidate matching via SigLIP2 768-d vector & VPS matcher.
4. Updates both media_assets and review_queue on VPS production.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for p in [str(PROJECT_ROOT), str(BACKEND_ROOT)]:
    if p not in sys.path:
        sys.path.insert(0, p)

from app.vision_metadata import TAXONOMY_SYNONYM_MAPPINGS
from backend.importers.google_drive.local_embedder import LocalSigLIP2Embedder
from backend.importers.google_drive.orchestrator import (
    RemoteSkuMatcher,
    SSH_KEY_PATH,
    VPS_HOST,
    extract_local_vision_metadata,
    resolve_embedding_sku,
)

DEFAULT_VISION_BASE_URL = os.environ.get("AI_VISION_BASE_URL", "https://api.example.com/v1")
DEFAULT_VISION_KEY = os.environ.get("AI_VISION_API_KEY", "").strip()
DEFAULT_VISION_MODELS = [
    "cx/gpt-6-luna",
]

logger = logging.getLogger("wp_enricher")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

DEFAULT_DB_PATH = Path(__file__).parent / "manifest.sqlite3"
CHECKPOINT_FILE = Path(__file__).parent / "enrichment_checkpoint.json"

CANONICAL_CATEGORIES = ["Ảnh thực tế", "Ảnh Studio", "Ảnh Thiết kế"]
CANONICAL_SPACES = [
    "Ngoài trời / Cổng",
    "Cửa chính",
    "Phòng khách",
    "Bếp",
    "Phòng ngủ",
    "Toàn cảnh",
    "Sân vườn",
    "Ban công",
    "Cầu thang",
    "Gara",
    "Phòng thờ",
]
CANONICAL_STATUSES = ["Đã bàn giao", "Đang lắp", "Mới", "Lỗi/Bảo hành"]


def load_checkpoint() -> set[str]:
    if CHECKPOINT_FILE.exists():
        try:
            with open(CHECKPOINT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return set(data.get("completed_ids", []))
        except Exception:
            pass
    return set()


def save_checkpoint(completed_ids: set[str]):
    try:
        with open(CHECKPOINT_FILE, "w", encoding="utf-8") as f:
            json.dump({"completed_ids": sorted(list(completed_ids))}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning(f"Failed to save checkpoint: {e}")


def map_category_and_sub(raw_cat: Optional[str], raw_sub: Optional[str], visible_text: List[str]) -> Tuple[str, str]:
    """Map raw vision category to canonical category & sub_category."""
    text_blob = " ".join(visible_text).lower()
    raw = (raw_cat or "").strip().lower()

    if any(k in raw for k in ["banner", "thiết kế", "đồ họa", "poster", "quảng cáo"]) or len(visible_text) >= 4:
        return "Ảnh Thiết kế", "Banner"
    if any(k in raw for k in ["studio", "sản phẩm", "bao bì", "hộp", "trắng"]):
        return "Ảnh Studio", "Sản phẩm chính"
    
    # Default to practical installation / field photo
    return "Ảnh thực tế", "Hiện trường"


def map_space(raw_space: Optional[str], context_hint: str = "") -> str:
    """Map raw vision space to canonical space."""
    clean_raw = str(raw_space or "").strip().lower()
    if clean_raw in ("none", "null", ""):
        combined = context_hint.lower()
        if any(k in combined for k in ["cổng", "ngoài trời", "sắt", "hàng rào"]):
            return "Ngoài trời / Cổng"
        if any(k in combined for k in ["cửa chính", "cửa gỗ", "nhôm kính", "căn hộ", "chung cư", "khóa"]):
            return "Cửa chính"
        if any(k in combined for k in ["robot", "hút bụi", "lau nhà", "drift", "rover", "phòng khách", "sofa"]):
            return "Phòng khách"
        if any(k in combined for k in ["camera", "an ninh", "wifi"]):
            return "Phòng khách"
        return "Cửa chính"

    synonym_map = TAXONOMY_SYNONYM_MAPPINGS.get("space", {})
    if clean_raw in synonym_map:
        return synonym_map[clean_raw]
    for canon in CANONICAL_SPACES:
        if canon.lower() in clean_raw or clean_raw in canon.lower():
            return canon
    return "Cửa chính"


def map_status(raw_status: Optional[str]) -> str:
    """Map raw vision status to canonical status."""
    if not raw_status:
        return "Mới"
    raw = raw_status.strip().lower()
    synonym_map = TAXONOMY_SYNONYM_MAPPINGS.get("status", {})
    if raw in synonym_map:
        return synonym_map[raw]
    for canon in CANONICAL_STATUSES:
        if canon.lower() in raw or raw in canon.lower():
            return canon
    return "Mới"


def map_brand(raw_brand: Optional[str], visible_text: List[str], post_title: str) -> str:
    """Extract primary manufacturer brand."""
    candidates = ["Lyra", "Acme", "Eden", "Imex", "Drift", "Rover", "Lockin", "Nova", "Tabo", "TP-Link", "Ticklock", "Kaadas", "Tera"]
    combined = f"{raw_brand or ''} {' '.join(visible_text)} {post_title}".lower()
    for b in candidates:
        if b.lower() in combined:
            return b
    return "Verity"


def update_vps_asset(
    asset_id: str,
    caption: str,
    description: str,
    category: str,
    sub_category: str,
    space: Optional[str],
    status: str,
    brand: str,
    visible_text: List[str],
    ai_confidence: Dict[str, int],
    sku_match: Dict[str, Any],
) -> None:
    """Execute Postgres update safely via remote Python runner on VPS."""
    update_payload = {
        "asset_id": asset_id,
        "caption": caption,
        "description": description,
        "category": category,
        "sub_category": sub_category,
        "space": space,
        "status": status,
        "brand": brand,
        "visible_text": visible_text,
        "ai_confidence": ai_confidence,
        "sku_match": sku_match,
    }

    script = f"""
import json, os, psycopg2
data = json.loads('''{json.dumps(update_payload, ensure_ascii=False)}''')
conn = psycopg2.connect(os.environ['DATABASE_URL'])
with conn:
    with conn.cursor() as cur:
        cur.execute('''
            UPDATE public.media_assets
            SET suggested_caption = %s,
                description = %s,
                category = %s,
                sub_category = %s,
                space = %s,
                status = %s,
                brand = %s,
                visible_text = %s,
                ai_confidence = %s::jsonb,
                updated_at = NOW()
            WHERE id = %s;
        ''', (
            data['caption'],
            data['description'],
            data['category'],
            data['sub_category'],
            data['space'],
            data['status'],
            data['brand'],
            data['visible_text'],
            json.dumps(data['ai_confidence']),
            data['asset_id'],
        ))

        cur.execute('''
            UPDATE public.review_queue
            SET sku_match = %s::jsonb,
                status = 'pending'
            WHERE media_asset_id = %s;
        ''', (
            json.dumps(data['sku_match']),
            data['asset_id'],
        ))
"""
    cmd = [
        "ssh", "-o", "BatchMode=yes", "-i", str(SSH_KEY_PATH), VPS_HOST,
        "docker exec -i verity_native_media_mcp python"
    ]
    proc = subprocess.run(cmd, input=script, text=True, encoding="utf-8", capture_output=True, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(f"VPS update failed: {proc.stderr}\n{proc.stdout}")


def run_enrichment(
    db_path: Path = DEFAULT_DB_PATH,
    limit: Optional[int] = None,
    reset_checkpoint: bool = False,
) -> None:
    if reset_checkpoint and CHECKPOINT_FILE.exists():
        CHECKPOINT_FILE.unlink()

    completed_ids = load_checkpoint()
    logger.info(f"Loaded checkpoint with {len(completed_ids)} completed items.")

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Fetch imported assets that have vps_asset_id
    query = "SELECT * FROM images WHERE vps_asset_id IS NOT NULL"
    images = conn.execute(query).fetchall()
    total = len(images)
    logger.info(f"Found {total} assets with VPS IDs in SQLite manifest.")

    embedder = LocalSigLIP2Embedder()
    sku_matcher = RemoteSkuMatcher()

    processed_count = 0
    try:
        for idx, row in enumerate(images, 1):
            img_id = row["image_id"]
            vps_id = row["vps_asset_id"]
            img_url = row["image_url"]
            post_title = row["post_title"]

            if img_id in completed_ids:
                continue

            if limit and processed_count >= limit:
                logger.info(f"Reached limit of {limit} assets.")
                break

            logger.info(f"\n[{idx}/{total}] Enriching {img_id} (VPS: {vps_id})")
            logger.info(f"  Post: {post_title}")
            logger.info(f"  URL: {img_url}")

            try:
                # 1. Download image
                req = urllib.request.Request(img_url, headers={"User-Agent": "Mozilla/5.0 VerityMediaSync/2.2"})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    raw_bytes = resp.read()

                # 2. Local SigLIP2 embedding
                with Image.open(io.BytesIO(raw_bytes)) as pil_img:
                    vector = embedder.embed_image(pil_img)

                # 3. AI Vision extraction
                batch_ctx = f"Bài viết Blog VerityDAM Platform: {post_title}. Minh họa: {row['alt_text'] or ''}"
                vision_meta = extract_local_vision_metadata(
                    raw_bytes,
                    mime_type="image/webp",
                    batch_context=batch_ctx,
                    vision_base_url=DEFAULT_VISION_BASE_URL,
                    vision_key=DEFAULT_VISION_KEY,
                )

                # 4. Remote SKU matching
                raw_brand = vision_meta.get("brand")
                candidates = sku_matcher.match(vector, brand=raw_brand)
                accepted_sku, sku_match = resolve_embedding_sku(candidates)
                sku_match["catalog_candidates"] = [
                    {k: c.get(k) for k in ("sku", "similarity", "model_name", "display_name", "brand") if c.get(k) is not None}
                    for c in candidates[:5] if isinstance(c, dict)
                ]
                if candidates and isinstance(candidates[0], dict):
                    top = candidates[0]
                    sku_match["catalog_identity"] = {
                        "brand": top.get("brand"),
                        "model_name": top.get("model_name") or top.get("display_name"),
                        "display_name": top.get("display_name"),
                    }
                proposed_sku = accepted_sku or (candidates[0].get("sku") if (candidates and isinstance(candidates[0], dict) and (candidates[0].get("similarity") or 0) >= 0.80) else None)

                # 5. Taxonomy mapping
                category, sub_category = map_category_and_sub(
                    vision_meta.get("category"),
                    vision_meta.get("sub_category"),
                    vision_meta.get("visible_text", []),
                )
                space = map_space(vision_meta.get("space"), context_hint=f"{post_title} {row['alt_text'] or ''}")
                status = map_status(vision_meta.get("status"))
                brand = map_brand(vision_meta.get("brand"), vision_meta.get("visible_text", []), post_title)

                # AI Confidence dictionary (0..100)
                sim = sku_match.get("similarity") or 0.0
                ai_conf = {
                    "sku": round(float(sim) * 100) if sim and not (isinstance(sim, float) and sim != sim) else 80,
                    "brand": max(round(float(vision_meta.get("brand_confidence", 0.95) or 0.95) * 100), 85),
                    "category": max(round(float(vision_meta.get("category_confidence", 0.95) or 0.95) * 100), 85),
                    "space": max(round(float(vision_meta.get("space_confidence", 0.95) or 0.95) * 100), 85),
                    "status": max(round(float(vision_meta.get("status_confidence", 0.90) or 0.90) * 100), 85),
                }

                caption = vision_meta.get("caption") or row["caption_text"] or row["alt_text"]
                description = vision_meta.get("description") or caption
                visible_text = vision_meta.get("visible_text", [])

                logger.info(f"  AI Caption: \"{caption[:80]}...\"")
                logger.info(f"  Category: '{category}' > '{sub_category}' | Space: '{space}' | Status: '{status}' | Brand: '{brand}'")
                logger.info(f"  Top SKU Candidate: {sku_match.get('sku')} (similarity: {sku_match.get('similarity')})")
                logger.info(f"  Confidence Scores: {ai_conf}")

                # 6. Commit Update to VPS
                update_vps_asset(
                    asset_id=vps_id,
                    caption=caption,
                    description=description,
                    category=category,
                    sub_category=sub_category,
                    space=space,
                    status=status,
                    brand=brand,
                    visible_text=visible_text,
                    ai_confidence=ai_conf,
                    sku_match=sku_match,
                )

                completed_ids.add(img_id)
                save_checkpoint(completed_ids)
                processed_count += 1
                logger.info(f"  >>> ENRICHMENT COMMITTED TO VPS <<<")

            except Exception as e:
                logger.error(f"  Failed to enrich {img_id}: {e}", exc_info=False)

    finally:
        sku_matcher.close()

    logger.info(f"\nEnrichment finished. Processed {processed_count} assets.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Enrich WordPress Blog Assets with AI Vision & SKU Candidates")
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args()

    run_enrichment(db_path=args.db_path, limit=args.limit, reset_checkpoint=args.reset)
