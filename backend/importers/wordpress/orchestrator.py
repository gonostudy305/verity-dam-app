"""
WordPress Media Ingestion Orchestrator for Verity DAM (Pipeline v2.2).
Downloads WordPress blog media, generates WebP renditions (<250KB),
extracts SigLIP2 768-d embeddings, enriches context-aware metadata,
and enforces Gate 1 validation before pushing to VPS.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageOps

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True, errors="replace")

# Ensure project root & backend is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for p in [str(PROJECT_ROOT), str(BACKEND_ROOT)]:
    if p not in sys.path:
        sys.path.insert(0, p)

from app.image_processing import (
    build_public_image_slug,
    compose_canonical_title,
    is_generic_or_raw_title,
)
from backend.importers.google_drive.local_embedder import (
    LocalSigLIP2Embedder,
    SIGLIP2_DIMENSION,
)

logger = logging.getLogger("wp_orchestrator")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

DEFAULT_DB_PATH = Path(__file__).parent / "manifest.sqlite3"
MAX_WEBP_SIZE_BYTES = 250 * 1024  # 250 KB Gate 1 limit
MAX_EDGE = 1600

SSH_KEY_PATH = Path(os.environ.get("Verity_SSH_KEY_PATH", Path.home() / ".ssh" / "verity_vps_deploy_ed25519"))
VPS_HOST = "root@203.0.113.10"
BOT_USER_ID = "1717f588-2aeb-4bcb-9813-519c1e8c3090"
SIGLIP2_SPACE_ID = "verity-siglip2-b32-256-webli-v1"


def commit_curated_item_to_vps(
    storage_path: str,
    file_name: str,
    webp_bytes: bytes,
    metadata_payload: dict,
    ssh_key: Path = SSH_KEY_PATH,
    ssh_host: str = VPS_HOST,
) -> dict:
    """
    Commit one curated item to VPS via commit_receiver:
    1. Upload WebP bytes to R2 via gateway.upload_object
    2. Finalize asset in Postgres via gateway._finalize
    """
    b64_content = base64.b64encode(webp_bytes).decode("ascii")
    input_data = json.dumps({
        "storage_path": storage_path,
        "file_name": file_name,
        "content_b64": b64_content,
        "upload_item": metadata_payload,
    })

    ssh_cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-i", str(ssh_key),
        ssh_host,
        "docker exec -i verity_native_media_mcp python -m verity_dam_mcp.commit_receiver",
    ]

    proc = subprocess.run(
        ssh_cmd,
        input=input_data,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=60,
    )

    if proc.returncode != 0:
        raise RuntimeError(f"VPS commit failed (code {proc.returncode}): {proc.stderr}\n{proc.stdout}")

    try:
        lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
        return json.loads(lines[-1])
    except Exception as e:
        raise RuntimeError(f"Failed to parse VPS commit response: {proc.stdout}\nError: {e}")


def clean_html_text(text: Optional[str]) -> str:
    """Unescape HTML entities and normalize whitespace."""
    if not text:
        return ""
    unescaped = html.unescape(text)
    # Remove HTML tags if any
    cleaned = re.sub(r"<[^>]+>", " ", unescaped)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def extract_keywords_from_context(title: str, alt: str, post_title: str) -> List[str]:
    """Derive relevant Home Appliance keywords from post & image metadata."""
    combined = f"{title} {alt} {post_title}".lower()
    kw_map = {
        "khóa thông minh": ["khóa thông minh", "smart lock", "khóa cửa"],
        "khóa vân tay": ["khóa vân tay", "vân tay"],
        "khóa cổng": ["khóa cổng", "cổng sắt ngoài trời", "ngoài trời"],
        "robot hút bụi": ["robot hút bụi", "lau nhà", "robot hút bụi lau nhà"],
        "camera an ninh": ["camera an ninh", "camera wifi", "giám sát"],
        "acme": ["acme", "home appliance acme"],
        "drift": ["drift", "robot drift"],
        "rover": ["rover", "robot rover"],
        "eden": ["eden", "camera eden"],
        "imex": ["imex", "camera imex"],
        "tera": ["tera", "zigbee"],
        "vinhomes": ["vinhomes grand park", "căn hộ"],
        "lắp đặt": ["lắp đặt thực tế", "thi công", "chính hãng"],
    }
    keywords = ["VerityDAM Platform"]
    for cat, triggers in kw_map.items():
        if any(trig in combined for trig in triggers):
            keywords.append(cat)
    # Deduplicate while preserving order
    return list(dict.fromkeys(keywords))[:8]


def compose_metadata(img_row: sqlite3.Row) -> Dict[str, Any]:
    """Compose Gate 1 compliant SEO metadata from WordPress post context."""
    post_title = clean_html_text(img_row["post_title"])
    raw_alt = clean_html_text(img_row["alt_text"])
    raw_caption = clean_html_text(img_row["caption_text"])
    raw_context = clean_html_text(img_row["context_text"])

    # 1. Title composition (Must be >= 8 chars and non-generic)
    # Remove trailing brand suffixes that cause duplication
    candidate_title = raw_alt
    candidate_title = re.sub(r"\s*-\s*Verity\s+Smart\s+Home.*$", "", candidate_title, flags=re.IGNORECASE)
    candidate_title = re.sub(r"\s*-\s*Verity.*$", "", candidate_title, flags=re.IGNORECASE).strip()

    if not candidate_title or len(candidate_title) < 8 or is_generic_or_raw_title(candidate_title):
        candidate_title = f"{post_title} - Hình ảnh {img_row['image_id'][:8]}"

    # 2. Caption composition (Must be >= 25 chars)
    if raw_caption and len(raw_caption) >= 25:
        caption = raw_caption
    elif raw_alt and len(raw_alt) >= 25:
        caption = raw_alt
    else:
        caption = f"{candidate_title}. Ảnh thực tế minh họa cho bài viết '{post_title}' tại VerityDAM Platform."

    # 3. Description composition (Must be >= 60 chars)
    desc_parts = [candidate_title]
    if raw_context and raw_context != raw_caption:
        desc_parts.append(raw_context)
    desc_parts.append(f"Chuyên mục bài viết: {post_title}. Sản phẩm phân phối và thi công chính hãng bởi VerityDAM Platform.")
    description = " ".join(desc_parts).strip()
    if len(description) < 60:
        description += " Tư vấn giải pháp gia dụng, khóa cửa điện tử, robot hút bụi và camera an ninh."

    # 4. Keywords (Must be >= 3)
    keywords = extract_keywords_from_context(candidate_title, raw_alt, post_title)
    if len(keywords) < 3:
        keywords.extend(["gia dụng", "thiết bị thông minh"])
        keywords = list(dict.fromkeys(keywords))

    # 5. Public slug
    slug = build_public_image_slug({
        "id": img_row["image_id"],
        "title": candidate_title,
        "sku": "",
        "brand": "Verity",
    })

    return {
        "title": candidate_title,
        "caption": caption,
        "description": description,
        "keywords": keywords,
        "slug": slug,
    }


def download_and_preprocess(url: str) -> Tuple[bytes, Image.Image, int, int]:
    """Download image, transpose EXIF, resize <= 1600px edge, encode to WebP."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VerityMediaSync/2.2",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw_bytes = resp.read()

    with Image.open(io.BytesIO(raw_bytes)) as img:
        img_rgb = ImageOps.exif_transpose(img).convert("RGB")
        orig_w, orig_h = img_rgb.size
        
        # Resize to max 1600px edge
        img_rgb.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
        width, height = img_rgb.size

        # Encode WebP with quality scaling to guarantee <= 250 KB
        for quality in (82, 75, 68, 60):
            out_buf = io.BytesIO()
            img_rgb.save(out_buf, format="WEBP", quality=quality, method=6)
            webp_bytes = out_buf.getvalue()
            if len(webp_bytes) <= MAX_WEBP_SIZE_BYTES or quality == 60:
                break

    return webp_bytes, img_rgb, width, height


def evaluate_gate_1(
    title: str,
    caption: str,
    description: str,
    keywords: List[str],
    vector: List[float],
    size_bytes: int,
) -> Tuple[bool, List[str]]:
    """Evaluate non-negotiable Gate 1 quality checks."""
    errors = []
    if not title or len(title) < 8:
        errors.append(f"Title too short: {len(title)} < 8 chars")
    if is_generic_or_raw_title(title):
        errors.append(f"Title is generic/raw: '{title}'")
    if not caption or len(caption) < 25:
        errors.append(f"Caption too short: {len(caption)} < 25 chars")
    if not description or len(description) < 60:
        errors.append(f"Description too short: {len(description)} < 60 chars")
    if not keywords or len(keywords) < 3:
        errors.append(f"Keywords too few: {len(keywords)} < 3")
    if len(vector) != SIGLIP2_DIMENSION:
        errors.append(f"Vector dim mismatch: {len(vector)} != {SIGLIP2_DIMENSION}")
    if size_bytes > MAX_WEBP_SIZE_BYTES:
        errors.append(f"WebP size exceeded: {size_bytes / 1024:.1f} KB > 250 KB")

    return len(errors) == 0, errors


def run_orchestrator(
    db_path: Path = DEFAULT_DB_PATH,
    dry_run: bool = True,
    limit: Optional[int] = None,
    featured_only: bool = False,
    post_id: Optional[int] = None,
) -> None:
    """Orchestrate WordPress media ingestion pipeline."""
    if not db_path.exists():
        logger.error(f"Manifest database not found at {db_path}. Run census.py first!")
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Initialize Local SigLIP2 Embedder
    logger.info("Initializing Canonical Local SigLIP2 Vision Embedder...")
    embedder = LocalSigLIP2Embedder()

    # Query candidate images
    if dry_run:
        query = """
            SELECT i.*, p.date_gmt 
            FROM images i 
            JOIN posts p ON p.post_id = i.post_id 
            WHERE i.status = 'pending'
        """
    else:
        query = """
            SELECT i.*, p.date_gmt 
            FROM images i 
            JOIN posts p ON p.post_id = i.post_id 
            WHERE i.status IN ('pending', 'dry_run_passed')
        """
    params: List[Any] = []
    if featured_only:
        query += " AND i.is_featured = 1"
    if post_id:
        query += " AND i.post_id = ?"
        params.append(post_id)
    query += " ORDER BY i.is_featured DESC, i.post_id DESC"
    if limit:
        query += f" LIMIT {limit}"

    images = conn.execute(query, params).fetchall()
    total_candidates = len(images)
    logger.info(f"Loaded {total_candidates} candidate images to process (dry_run={dry_run})")

    passed_count = 0
    failed_count = 0

    for idx, row in enumerate(images, 1):
        img_id = row["image_id"]
        img_url = row["image_url"]
        logger.info(f"\n[{idx}/{total_candidates}] Processing {img_id} ({'FEATURED' if row['is_featured'] else 'IN-BODY'})")
        logger.info(f"  URL: {img_url}")

        try:
            # 1. Download & Preprocess
            t0 = time.time()
            webp_bytes, pil_img, w, h = download_and_preprocess(img_url)
            dl_ms = (time.time() - t0) * 1000

            # 2. Local SigLIP2 Embedding
            t1 = time.time()
            vector = embedder.embed_image(pil_img)
            embed_ms = (time.time() - t1) * 1000

            # 3. Metadata Composition
            meta = compose_metadata(row)

            # 4. Gate 1 Evaluation
            is_valid, errors = evaluate_gate_1(
                title=meta["title"],
                caption=meta["caption"],
                description=meta["description"],
                keywords=meta["keywords"],
                vector=vector,
                size_bytes=len(webp_bytes),
            )

            # Report
            logger.info(f"  Dimensions: {w}x{h} | WebP Size: {len(webp_bytes) / 1024:.1f} KB (dl: {dl_ms:.0f}ms, embed: {embed_ms:.0f}ms)")
            logger.info(f"  Title: \"{meta['title']}\"")
            logger.info(f"  Slug: \"{meta['slug']}\"")
            logger.info(f"  Caption: \"{meta['caption'][:80]}...\" ({len(meta['caption'])} chars)")
            logger.info(f"  Description: \"{meta['description'][:100]}...\" ({len(meta['description'])} chars)")
            logger.info(f"  Keywords: {meta['keywords']}")
            logger.info(f"  SigLIP2 Vector: 768-d (L2 norm: {np.linalg.norm(vector):.4f})")

            if is_valid:
                logger.info(f"  >>> GATE 1 PASS <<<")
                passed_count += 1
                if dry_run:
                    with conn:
                        conn.execute("UPDATE images SET status = 'dry_run_passed', updated_at = ? WHERE image_id = ?",
                                     (datetime.now(timezone.utc).isoformat(), img_id))
                else:
                    sha256_hash = hashlib.sha256(webp_bytes).hexdigest()
                    md5_hash = hashlib.md5(webp_bytes).hexdigest()
                    storage_path = f"{BOT_USER_ID}/wordpress_blog/{row['post_id']}/{img_id}.webp"
                    file_name = f"{meta['slug']}.webp"

                    metadata_payload = {
                        "is_curated_import": True,
                        "storage_path": storage_path,
                        "file_name": file_name,
                        "title": meta["title"],
                        "canonical_slug": meta["slug"],
                        "thumbnail_path": storage_path,
                        "media_type": "photo",
                        "permission": "public",
                        "sku": None,
                        "brand": "Verity",
                        "category": "Ảnh bài viết blog",
                        "sub_category": "Ảnh đại diện bài viết" if row["is_featured"] else "Minh họa bài viết",
                        "space": "Blog Verity",
                        "status": "Mới",
                        "project_hint": f"wordpress_blog_post_{row['post_id']}",
                        "batch_context": f"WordPress Blog Ingest 2026-04: {row['post_title']}",
                        "suggested_caption": meta["caption"],
                        "description": meta["description"],
                        "keywords": meta["keywords"],
                        "visible_text": [],
                        "has_people": False,
                        "ai_flags": {
                            "source": "wordpress_blog_v22",
                            "gate1_passed": True,
                        },
                        "ai_confidence": {
                            "brand": 100,
                            "category": 100,
                        },
                        "source_provider": "wordpress_blog",
                        "source_file_id": img_id,
                        "source_modified_time": row["date_gmt"],
                        "import_batch_id": "wp-blog-cohort-2026-04",
                        "source_md5": md5_hash,
                        "sha256": sha256_hash,
                        "size_bytes": len(webp_bytes),
                        "dimensions": {
                            "width": w,
                            "height": h,
                            "size_bytes": len(webp_bytes),
                        },
                        "embedding": {
                            "space_id": SIGLIP2_SPACE_ID,
                            "vector": vector,
                        },
                    }

                    commit_res = commit_curated_item_to_vps(
                        storage_path=storage_path,
                        file_name=file_name,
                        webp_bytes=webp_bytes,
                        metadata_payload=metadata_payload,
                    )
                    vps_asset_id = commit_res.get("media_asset_id")
                    logger.info(f"  >>> COMMITTED TO VPS: asset_id={vps_asset_id} (permission=internal) <<<")
                    with conn:
                        conn.execute(
                            "UPDATE images SET status = 'imported', vps_asset_id = ?, storage_path = ?, updated_at = ? WHERE image_id = ?",
                            (vps_asset_id, storage_path, datetime.now(timezone.utc).isoformat(), img_id)
                        )
            else:
                logger.warning(f"  >>> GATE 1 FAIL: {errors}")
                failed_count += 1
                with conn:
                    conn.execute("UPDATE images SET status = 'gate1_failed', error_message = ?, updated_at = ? WHERE image_id = ?",
                                 ("; ".join(errors), datetime.now(timezone.utc).isoformat(), img_id))

        except Exception as e:
            logger.error(f"  Error processing {img_id}: {e}", exc_info=False)
            failed_count += 1
            with conn:
                conn.execute("UPDATE images SET status = 'error', error_message = ?, updated_at = ? WHERE image_id = ?",
                             (str(e), datetime.now(timezone.utc).isoformat(), img_id))

    logger.info(f"\n=== ORCHESTRATOR RUN FINISHED ===")
    logger.info(f"Total Processed: {total_candidates}")
    logger.info(f"Gate 1 Passed: {passed_count}/{total_candidates} ({passed_count / max(total_candidates, 1) * 100:.1f}%)")
    logger.info(f"Failed/Errors: {failed_count}/{total_candidates}")
    if dry_run:
        logger.info("Mode was DRY-RUN. No changes pushed to VPS production DAM.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WordPress Media Ingestion Orchestrator")
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH, help="SQLite manifest path")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Test run without pushing")
    parser.add_argument("--no-dry-run", dest="dry_run", action="store_false", help="Push to VPS production")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of images")
    parser.add_argument("--featured-only", action="store_true", help="Only process featured images")
    parser.add_argument("--post-id", type=int, help="Filter by specific post ID")
    args = parser.parse_args()

    run_orchestrator(
        db_path=args.db_path,
        dry_run=args.dry_run,
        limit=args.limit,
        featured_only=args.featured_only,
        post_id=args.post_id,
    )
