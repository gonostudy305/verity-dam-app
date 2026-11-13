"""
Google Drive Curated Lane Importer Orchestrator (1-Pass Architecture).
Streams Drive images into memory, converts to WebP, runs local SigLIP2 768-d embedding
with Hard Gate verification, calls AI Vision directly from workstation to extract
metadata, composes clean canonical SEO title & slug, enforces Fail-Closed Local Gate 1,
uploads WebP to R2, and finalizes as approved canonical assets in Postgres.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageOps
import requests

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

PROJECT_ROOT = Path(__file__).resolve().parents[3]
BACKEND_ROOT = PROJECT_ROOT / "backend"
for p in (str(PROJECT_ROOT), str(BACKEND_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

from backend.importers.google_drive.auth import get_drive_service
from backend.importers.google_drive.local_embedder import (
    LocalSigLIP2Embedder,
    SIGLIP2_DIMENSION,
    SIGLIP2_SPACE_ID,
)
from app.image_processing import (
    build_public_image_slug,
    compose_canonical_title,
    is_generic_or_raw_title,
)
from app.vision_metadata import metadata_messages
from app.contracts import gate_sku_candidates, sanitize_vision_metadata

SSH_KEY_PATH = Path.home() / ".ssh" / "verity_vps_deploy_ed25519"
VPS_HOST = "root@203.0.113.10"
DEFAULT_DB_PATH = Path(__file__).parent / "manifest.sqlite3"
BOT_USER_ID = "1717f588-2aeb-4bcb-9813-519c1e8c3090"

DEFAULT_VISION_BASE_URL = os.environ.get("AI_VISION_BASE_URL", "https://api.example.com/v1")
DEFAULT_VISION_KEY = os.environ.get("AI_VISION_API_KEY", "")
DEFAULT_VISION_MODELS = [
    "cx/gpt-6-luna",
]


class RemoteSkuMatcher:
    """Persistent SSH stream to the production reference matcher with auto-reconnect.

    Matching must use the same ``reference_embeddings`` space and gates as the
    production worker. Keeping one process open avoids creating an SSH
    connection for every image while keeping all database credentials on VPS.
    """

    def __init__(self, ssh_key: Path = SSH_KEY_PATH, ssh_host: str = VPS_HOST) -> None:
        self.ssh_key = ssh_key
        self.ssh_host = ssh_host
        self.process: subprocess.Popen | None = None
        self._start_process()

    def _start_process(self) -> None:
        self.process = subprocess.Popen(
            [
                "ssh",
                "-o", "BatchMode=yes",
                "-o", "ServerAliveInterval=30",
                "-o", "ServerAliveCountMax=3",
                "-i", str(self.ssh_key),
                self.ssh_host,
                "docker exec -i verity_native_media_mcp python -m verity_dam_mcp.sku_match_receiver",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

    def _ensure_process(self) -> None:
        if self.process is None or self.process.poll() is not None:
            self.close()
            self._start_process()

    def match(self, vector: list[float], brand: str | None = None) -> list[dict[str, Any]]:
        if len(vector) != SIGLIP2_DIMENSION:
            raise ValueError(f"SKU matcher requires {SIGLIP2_DIMENSION}-d vector")
        payload = {"vector": vector}
        if brand and brand != "Verity":
            payload["brand"] = brand
        payload_line = json.dumps(payload, separators=(",", ":")) + "\n"

        for attempt in range(2):
            self._ensure_process()
            if self.process is None or self.process.stdin is None or self.process.stdout is None:
                raise RuntimeError("SKU matcher stream is unavailable")
            try:
                self.process.stdin.write(payload_line)
                self.process.stdin.flush()
                line = self.process.stdout.readline()
                if not line:
                    stderr = self.process.stderr.read()[-1000:] if self.process.stderr else ""
                    self.close()
                    if attempt == 0:
                        continue
                    raise RuntimeError(f"Production SKU matcher closed unexpectedly: {stderr}")
                response = json.loads(line)
                if isinstance(response, dict) and response.get("error"):
                    raise RuntimeError(str(response["error"]))
                candidates = response.get("candidates") if isinstance(response, dict) else None
                if not isinstance(candidates, list):
                    raise RuntimeError("Production SKU matcher returned an invalid candidate payload")
                return candidates
            except (OSError, BrokenPipeError, ValueError) as err:
                self.close()
                if attempt == 0:
                    continue
                raise RuntimeError(f"SKU matcher connection error: {err}")
        raise RuntimeError("SKU matcher failed after retry")

    def close(self) -> None:
        if self.process:
            if self.process.stdin:
                try:
                    self.process.stdin.close()
                except Exception:
                    pass
            try:
                self.process.wait(timeout=5)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None



def resolve_embedding_sku(
    candidates: list[dict[str, Any]],
) -> tuple[str | None, dict[str, Any]]:
    """Accept only an unambiguous high-confidence embedding match.

    Low-confidence and ambiguous proposals stay visible in ``sku_match`` but
    do not create a catalog link.  This prevents a visually similar model from
    becoming confirmed SKU data merely because k-NN always returns a winner.
    """
    decision = gate_sku_candidates(candidates)
    decision_payload = decision.as_dict()
    accepted = (
        decision.sku
        if decision.confidence_band == "high"
        and not decision.requires_reviewer_confirmation
        else None
    )
    return accepted, decision_payload


def convert_image_to_webp(raw_bytes: bytes, max_edge: int = 1600) -> tuple[bytes, int, int]:
    """
    Convert raw image bytes to WebP and return (webp_bytes, width, height).
    Applies EXIF transposition, bounds max edge to 1600px, and adjusts quality
    to guarantee < 250 KB for optimal web delivery.
    Supports Sony RAW (.ARW) and standard formats (JPEG, PNG, HEIF, WebP).
    """
    rgb = None
    try:
        with Image.open(io.BytesIO(raw_bytes)) as img:
            rgb = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:
        # Fallback to rawpy for Sony RAW (.ARW, .CR2, .NEF, etc.)
        try:
            import rawpy
            with rawpy.imread(io.BytesIO(raw_bytes)) as raw:
                rgb_array = raw.postprocess(use_camera_wb=True)
            rgb = Image.fromarray(rgb_array)
        except Exception as raw_err:
            raise ValueError(f"Failed to decode image bytes: {raw_err}")

    if rgb is None:
        raise ValueError("Decoded image is None")

    if max(rgb.size) > max_edge:
        rgb.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    width, height = rgb.size

    for quality in (82, 75, 70, 60, 50, 40):
        buf = io.BytesIO()
        rgb.save(buf, format="WEBP", quality=quality, method=4)
        data = buf.getvalue()
        if len(data) <= 245 * 1024:
            return data, width, height

    # If still over 245KB, scale down slightly and save
    rgb.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
    width, height = rgb.size
    for quality in (75, 60, 50):
        buf = io.BytesIO()
        rgb.save(buf, format="WEBP", quality=quality, method=4)
        data = buf.getvalue()
        if len(data) <= 245 * 1024 or quality == 50:
            return data, width, height
    return data, width, height


def extract_local_vision_metadata(
    image_bytes: bytes,
    mime_type: str = "image/webp",
    batch_context: str | None = None,
    vision_base_url: str = DEFAULT_VISION_BASE_URL,
    vision_key: str = DEFAULT_VISION_KEY,
    models: list[str] | None = None,
    timeout: int = 45,
    max_quota_waits: int = 3,
) -> dict[str, Any]:
    """
    Execute AI Vision per-image locally before commit.
    Uses multi-model pool with automatic failover on 429 quota exhaustion and backoff.
    """
    if not vision_key:
        raise ValueError("AI_VISION_API_KEY environment variable is required for local vision metadata extraction")
    candidate_models = models or DEFAULT_VISION_MODELS
    messages = metadata_messages(
        image_bytes=image_bytes,
        mime_type=mime_type,
        examples=[],
        system_prompt="Return open media metadata JSON only. Never invent brands.",
        image_detail="high",
        batch_context=batch_context,
    )
    headers = {
        "Authorization": f"Bearer {vision_key}",
        "Content-Type": "application/json",
    }

    quota_waits = 0
    while True:
        last_err = None
        for model in candidate_models:
            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.2,
                "max_tokens": 2048,
                "stream": False,
            }
            try:
                resp = requests.post(
                    f"{vision_base_url.rstrip('/')}/chat/completions",
                    headers=headers,
                    json=payload,
                    timeout=timeout,
                )
                if resp.status_code == 429:
                    print(f"  [warn] Model {model} hit 429 rate limit. Failing over to next model...")
                    last_err = f"429 from {model}"
                    continue
                if not resp.ok:
                    print(f"  [warn] Model {model} error ({resp.status_code}): {resp.text[:120]}")
                    last_err = f"{resp.status_code} from {model}: {resp.text}"
                    continue

                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                return sanitize_vision_metadata(content)

            except Exception as e:
                print(f"  [warn] Exception calling {model}: {e}")
                last_err = str(e)
                continue

        # If all candidate models failed, wait and back off
        quota_waits += 1
        if quota_waits > max_quota_waits:
            raise RuntimeError(f"All vision models failed after {max_quota_waits} backoff cycles. Last error: {last_err}")

        wait_seconds = 45 * quota_waits
        print(f"  [info] All vision models exhausted or timed out. Backing off for {wait_seconds}s before retrying (cycle {quota_waits}/{max_quota_waits})...")
        time.sleep(wait_seconds)


def commit_curated_item_to_vps(
    storage_path: str,
    file_name: str,
    webp_bytes: bytes,
    metadata_payload: dict,
) -> dict:
    """
    Commit one curated item to VPS:
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
        "-i", str(SSH_KEY_PATH),
        VPS_HOST,
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


def run_curated_ingestion(
    folder_like_pattern: str,
    *,
    db_path: Path = DEFAULT_DB_PATH,
    sku_policy: str = "auto",  # 'auto' | 'folder' | 'none'
    default_brand: str = "Verity",
    default_sku: Optional[str] = None,
    default_category: str = "Ảnh thực tế",
    default_sub_category: Optional[str] = None,
    default_space: str = "Cửa cổng",
    project_hint: Optional[str] = None,
    batch_prefix: str = "c02",
    limit: Optional[int] = None,
    dry_run: bool = False,
    service: Optional[Any] = None,
    embedder: Optional[Any] = None,
    sku_matcher: Optional[Any] = None,
) -> dict[str, Any]:
    """
    Generalized 1-Pass Curated Ingestion Runner.
    Filters out videos strictly: WHERE mime_type LIKE 'image/%' AND mime_type NOT LIKE 'video/%'.
    """
    conn = sqlite3.connect(str(db_path))
    cur = conn.execute("""
        SELECT file_id, name, mime_type, size_bytes, md5_checksum, modified_time, folder_path, status
        FROM files
        WHERE folder_path LIKE ? 
          AND mime_type LIKE 'image/%'
          AND mime_type NOT LIKE 'video/%'
        ORDER BY name;
    """, (f"%{folder_like_pattern}%",))
    rows = cur.fetchall()
    total_images = len(rows)

    print(f"\n{'='*65}")
    print(f"CURATED INGESTION: {folder_like_pattern}")
    print(f"Candidates found: {total_images} images (videos strictly filtered)")
    print(f"SKU policy: {sku_policy} | Default SKU: {default_sku} | Dry run: {dry_run}")
    print(f"{'='*65}\n")

    if limit:
        unfinalized = [r for r in rows if r[7] != "finalized"]
        rows = unfinalized[:limit]
        print(f"[orchestrator] Limited to first {len(rows)} unfinalized images (out of {len(unfinalized)} pending).\n")


    if service is None:
        print("[1/3] Connecting to Google Drive API...")
        service = get_drive_service()

    if embedder is None:
        print("[2/3] Initializing Local SigLIP2 768-d Embedder (Hard Gate)...")
        embedder = LocalSigLIP2Embedder()

    print("[3/3] Starting 1-Pass Ingestion Pipeline (Vision + SigLIP2 + Pre-push Gate)...\n")

    batch_id = f"gdrive-{batch_prefix}-{datetime.now(timezone.utc):%Y%m%d%H%M}"
    success_count = 0
    skipped_count = 0
    error_count = 0
    sku_review_items: list[dict[str, Any]] = []
    start_time = time.time()

    for idx, (f_id, name, mime_type, orig_size, md5, mod_time, f_path, manifest_status) in enumerate(rows, 1):
        if manifest_status == "finalized":
            print(f"[{idx}/{len(rows)}] Skipping '{name}' (already finalized in manifest)")
            skipped_count += 1
            continue

        print(f"[{idx}/{len(rows)}] Processing '{name}' ({orig_size/1024:.1f} KB)...")
        item_start = time.time()

        try:
            # 1. Download stream from Google Drive
            dl_req = service.files().get_media(fileId=f_id)
            raw_bytes = dl_req.execute()
            if not raw_bytes:
                print(f"  [error] Empty response from Drive for {f_id}")
                error_count += 1
                continue

            # 2. Convert to WebP in memory
            webp_bytes, width, height = convert_image_to_webp(raw_bytes)
            webp_size_kb = len(webp_bytes) / 1024.0
            sha256_hash = hashlib.sha256(webp_bytes).hexdigest()

            # 3. Local SigLIP2 768-d Embedding (Hard Gate verified)
            with Image.open(io.BytesIO(webp_bytes)) as pil_img:
                vector = embedder.embed_image(pil_img)

            if len(vector) != SIGLIP2_DIMENSION:
                raise ValueError(f"[HARD GATE] Vector length {len(vector)} != {SIGLIP2_DIMENSION}")

            # 4. Local AI Vision Extraction (1-Pass with multi-model pool and failover)
            batch_context = project_hint or folder_like_pattern
            vision_meta = extract_local_vision_metadata(
                image_bytes=webp_bytes,
                mime_type="image/webp",
                batch_context=batch_context,
            )

            caption = (vision_meta.get("caption") or "").strip()
            description = (vision_meta.get("description") or "").strip()
            keywords = vision_meta.get("keywords") or []
            visible_text = vision_meta.get("visible_text") or []
            brand = default_brand if default_brand and default_brand != "Verity" else (vision_meta.get("brand") or default_brand or "Verity")
            category = default_category if default_category else (vision_meta.get("category") or "Khóa thông minh")
            space = vision_meta.get("space") or default_space
            status = vision_meta.get("status") or "Mới"

            # Determine SKU according to policy.  ``embedding`` is the only
            # policy allowed for mixed folders: a low/ambiguous match stays
            # unassigned and is retained in sku_match for review.
            sku_candidates: list[dict[str, Any]] = []
            sku_match: dict[str, Any] = {}
            matched_model_name: str | None = None
            matched_brand_name: str | None = None
            if sku_policy == "embedding":
                if sku_matcher is None:
                    raise RuntimeError("embedding SKU policy requires a production SKU matcher")
                sku_candidates = sku_matcher.match(vector, brand=brand)
                sku, sku_match = resolve_embedding_sku(sku_candidates)
                if sku:
                    winner = next((row for row in sku_candidates if row.get("sku") == sku), None)
                    if isinstance(winner, dict):
                        raw_model_name = winner.get("model_name")
                        matched_model_name = raw_model_name.strip() if isinstance(raw_model_name, str) and raw_model_name.strip() else None
                        raw_brand_name = winner.get("brand")
                        matched_brand_name = raw_brand_name.strip() if isinstance(raw_brand_name, str) and raw_brand_name.strip() else None
                sku_match["catalog_candidates"] = [
                    {
                        key: candidate.get(key)
                        for key in ("sku", "similarity", "model_name", "display_name", "brand")
                        if candidate.get(key) is not None
                    }
                    for candidate in sku_candidates[:5]
                    if isinstance(candidate, dict)
                ]
                if (
                    not sku
                    or sku_match.get("confidence_band") != "high"
                    or bool(sku_match.get("requires_reviewer_confirmation"))
                ):
                    sku_review_items.append({
                        "source_file_id": f_id,
                        "name": name,
                        "folder_path": f_path,
                        "accepted_sku": sku,
                        "proposed_sku": sku_match.get("sku"),
                        "proposed_model_name": (
                            sku_match.get("catalog_candidates", [{}])[0].get("model_name")
                            if sku_match.get("catalog_candidates") else None
                        ),
                        "confidence_band": sku_match.get("confidence_band"),
                        "similarity": sku_match.get("similarity"),
                        "runner_up_similarity": sku_match.get("runner_up_similarity"),
                        "margin": sku_match.get("margin"),
                        "ambiguity_warning": sku_match.get("ambiguity_warning"),
                        "requires_reviewer_confirmation": sku_match.get("requires_reviewer_confirmation"),
                        "consistency_note": sku_match.get("consistency_note"),
                        "catalog_candidates": sku_match.get("catalog_candidates", []),
                    })
            elif sku_policy == "none":
                sku = None
            elif sku_policy == "folder":
                folder_leaf = Path(f_path).name.strip()
                sku = default_sku or folder_leaf
            else:  # auto
                sku = default_sku
                if sku_matcher is not None:
                    try:
                        sku_candidates = sku_matcher.match(vector, brand=brand)
                        _, auto_match = resolve_embedding_sku(sku_candidates)
                        sku_match = auto_match
                        sku_match["catalog_candidates"] = [
                            {
                                key: candidate.get(key)
                                for key in ("sku", "similarity", "model_name", "display_name", "brand")
                                if candidate.get(key) is not None
                            }
                            for candidate in sku_candidates[:5]
                            if isinstance(candidate, dict)
                        ]
                        winner = next((row for row in sku_candidates if row.get("sku") == sku), None)
                        if isinstance(winner, dict):
                            raw_model_name = winner.get("model_name")
                            matched_model_name = raw_model_name.strip() if isinstance(raw_model_name, str) and raw_model_name.strip() else None
                    except Exception as err:
                        print(f"  [warn] Failed to fetch catalog candidates for auto SKU: {err}")

            if matched_brand_name:
                brand = matched_brand_name

            # 5. Compose Canonical SEO Title & Slug
            asset_candidate = {
                "brand": brand,
                "sku": sku,
                "category": category,
                "space": space,
                "suggested_caption": caption,
                "title": None,
            }
            # Compose distinctive, descriptive canonical title
            first_clause = caption.split(".")[0].strip() if caption else ""
            if first_clause.lower().startswith("hình ảnh thi công thực tế"):
                sentences = [s.strip() for s in caption.split(".") if s.strip()]
                first_clause = sentences[1] if len(sentences) > 1 else ""

            prefix_parts = [p for p in (matched_model_name or sku or brand, space or category) if p]
            prefix = " - ".join(prefix_parts)

            if first_clause:
                first_clause = first_clause.strip(" ,;:-")
                if len(first_clause) > 70:
                    first_clause = first_clause[:67].rsplit(" ", 1)[0]
                clean_title = f"{prefix} - {first_clause}" if prefix else first_clause
            else:
                clean_title = compose_canonical_title(asset_candidate) or prefix

            slug = build_public_image_slug({**asset_candidate, "title": clean_title})
            file_name = f"{slug}.webp"
            storage_path = f"{BOT_USER_ID}/gdrive/{batch_prefix}/{f_id}.webp"

            # 6. FAIL-CLOSED PRE-PUSH GATE (Gate 1)
            if is_generic_or_raw_title(clean_title) or len(clean_title) < 8:
                raise ValueError(f"[GATE 1 FAIL] Generic or too short title: '{clean_title}'")
            if not caption or len(caption) < 25:
                raise ValueError(f"[GATE 1 FAIL] Caption missing or too short ({len(caption)} < 25)")
            if not description or len(description) < 60:
                raise ValueError(f"[GATE 1 FAIL] Description missing or too short ({len(description)} < 60)")
            if description.strip().lower() == caption.strip().lower():
                raise ValueError("[GATE 1 FAIL] Description is identical to caption; rich detailed paragraph required")
            if caption == "Hình ảnh thi công thực tế khóa cổng thông minh Verity C02":
                raise ValueError("[GATE 1 FAIL] Caption is static placeholder, not dynamic vision")
            if not keywords or len(keywords) < 3:
                raise ValueError(f"[GATE 1 FAIL] Insufficient keywords ({len(keywords)} < 3)")
            if len(vector) != SIGLIP2_DIMENSION:
                raise ValueError(f"[GATE 1 FAIL] Vector dimension {len(vector)} != {SIGLIP2_DIMENSION}")
            if len(webp_bytes) > 250 * 1024:
                raise ValueError(f"[GATE 1 FAIL] WebP size {webp_size_kb:.1f} KB exceeds 250 KB")

            metadata_payload = {
                "is_curated_import": True,
                "storage_path": storage_path,
                "file_name": file_name,
                "title": clean_title,
                "canonical_slug": slug,
                "thumbnail_path": storage_path,
                "media_type": "photo",
                "permission": "public",
                "sku": sku,
                "brand": brand,
                "category": category,
                "sub_category": default_sub_category or vision_meta.get("sub_category") or "Hiện trường",
                "space": space,
                "status": status,
                "project_hint": project_hint or folder_like_pattern,
                "batch_context": batch_context,
                "suggested_caption": caption,
                "description": description,
                "keywords": keywords,
                "visible_text": visible_text,
                "has_people": bool(vision_meta.get("has_people", False)),
                "ai_flags": {
                    "sku_match_source": "embedding_reference" if sku_policy == "embedding" else "folder_policy",
                    "sku_confidence_band": sku_match.get("confidence_band"),
                    "sku_requires_reviewer_confirmation": bool(sku_match.get("requires_reviewer_confirmation")),
                },
                "ai_confidence": {
                    "sku": round(float(sku_match.get("similarity", 0) or 0) * 100),
                    "brand": round(float(vision_meta.get("brand_confidence", 0) or 0) * 100),
                    "category": round(float(vision_meta.get("category_confidence", 0) or 0) * 100),
                    "space": round(float(vision_meta.get("space_confidence", 0) or 0) * 100),
                },
                "sku_match": sku_match,
                "source_provider": "google_drive",
                "source_file_id": f_id,
                "source_modified_time": mod_time,
                "import_batch_id": batch_id,
                "source_md5": md5,
                "sha256": sha256_hash,
                "size_bytes": len(webp_bytes),
                "dimensions": {
                    "width": width,
                    "height": height,
                    "size_bytes": len(webp_bytes),
                },
                "embedding": {
                    "space_id": SIGLIP2_SPACE_ID,
                    "vector": vector,
                },
            }

            if dry_run:
                print(f"  [dry-run] WebP: {webp_size_kb:.1f} KB | Title: '{clean_title}' | Slug: '{slug}'")
                print(f"            Caption: '{caption[:70]}...'")
                print(f"            SKU: {sku or 'None (Needs Review)'} | Winner: {sku_match.get('sku')} | Sim: {sku_match.get('similarity')} ({sku_match.get('confidence_band')}) | Model: {matched_model_name or 'N/A'}")
                success_count += 1
                continue


            # 7. Commit to VPS (R2 upload + Postgres finalize with ingest_status='ready')
            commit_res = commit_curated_item_to_vps(
                storage_path=storage_path,
                file_name=file_name,
                webp_bytes=webp_bytes,
                metadata_payload=metadata_payload,
            )

            asset_id = commit_res.get("media_asset_id")
            review_state = commit_res.get("review_state")
            status_code = commit_res.get("status", "finalized")

            # Update local manifest
            with conn:
                conn.execute("""
                    UPDATE files
                    SET status = 'finalized'
                    WHERE file_id = ?;
                """, (f_id,))

            elapsed = time.time() - item_start
            if status_code == "already_imported":
                print(f"  -> ALREADY IMPORTED on VPS. Asset ID: {asset_id} | {elapsed:.2f}s")
                skipped_count += 1
            else:
                print(f"  -> SUCCESS! Asset ID: {asset_id} | State: {review_state} | Title: '{clean_title}' | {elapsed:.2f}s")
                success_count += 1
                time.sleep(1.0)

        except Exception as e:
            print(f"  [error] Failed to process {name}: {e}")
            error_count += 1

    total_time = time.time() - start_time
    report_path: str | None = None
    if sku_policy == "embedding":
        report_dir = BACKEND_ROOT / "importers" / "google_drive" / "reports"
        report_dir.mkdir(parents=True, exist_ok=True)
        report_file = report_dir / f"{batch_id}-sku-review.json"
        report_file.write_text(
            json.dumps(
                {
                    "batch_id": batch_id,
                    "folder_pattern": folder_like_pattern,
                    "sku_policy": sku_policy,
                    "embedding_space_id": SIGLIP2_SPACE_ID,
                    "embedding_dimension": SIGLIP2_DIMENSION,
                    "dry_run": dry_run,
                    "total": len(rows),
                    "successful": success_count,
                    "skipped": skipped_count,
                    "errors": error_count,
                    "review_required": len(sku_review_items),
                    "items": sku_review_items,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        report_path = str(report_file)
    print(f"\n{'='*65}")
    print("CURATED INGESTION SUMMARY")
    print(f"{'='*65}")
    print(f"Total processed: {len(rows)}")
    print(f"Successful:      {success_count}")
    print(f"Skipped:         {skipped_count}")
    print(f"Errors:          {error_count}")
    if sku_policy == "embedding":
        print(f"SKU review needed: {len(sku_review_items)}")
        print(f"SKU review report: {report_path}")
    print(f"Total time:      {total_time:.1f}s")
    print(f"{'='*65}\n")

    conn.close()
    return {
        "total": len(rows),
        "successful": success_count,
        "skipped": skipped_count,
        "errors": error_count,
        "sku_review_required": len(sku_review_items),
        "sku_review_items": sku_review_items,
        "sku_review_report": report_path,
    }


PHASE_1_FOLDERS = [
    {
        "pattern": "Khoá Verity N1",
        "sku": "Verity N1",
        "brand": "Verity",
        "category": "Khóa thông minh",
        "space": "Cửa cổng",
        "prefix": "n1",
        "hint": "Khóa cổng Verity N1",
    },
    {
        "pattern": "Khóa Verity A1",
        "sku": "Verity A1",
        "brand": "Verity",
        "category": "Khóa thông minh",
        "space": "Cửa chính",
        "prefix": "a1",
        "hint": "Khóa vân tay Verity A1",
    },
    {
        "pattern": "Khóa Melo 301",
        "sku": "Verity Melo 301",
        "brand": "Verity",
        "category": "Khóa thông minh",
        "space": "Cửa nhôm Xingfa",
        "prefix": "melo301",
        "hint": "Khóa cửa nhôm Verity Melo 301",
    },
    {
        "pattern": "Khoá SL210",
        "sku": "Verity SL210",
        "brand": "Verity",
        "category": "Khóa thông minh",
        "space": "Cửa nhôm Xingfa",
        "prefix": "sl210",
        "hint": "Khóa cửa nhôm Verity SL210",
    },
    {
        "pattern": "Khoá SL108",
        "sku": "Verity SL108",
        "brand": "Verity",
        "category": "Khóa thông minh",
        "space": "Cửa nhôm Xingfa",
        "prefix": "sl108",
        "hint": "Khóa cửa nhôm Verity SL108",
    },
    {
        "pattern": "Verity NT01",
        "sku": "Verity NT01",
        "brand": "Verity",
        "category": "Khóa thông minh",
        "space": "Cửa cổng",
        "prefix": "nt01",
        "hint": "Khóa cổng Verity NT01",
    },
]


def run_phase_1(limit_per_folder: Optional[int] = None, dry_run: bool = False):
    """
    Execute Phase 1: Verity Core Locks across all 6 folders in a single orchestrated run.
    Reuses the authenticated Drive service and local SigLIP2 embedder across folders.
    """
    print(f"\n{'='*70}")
    print("STARTING PHASE 1: Verity CORE LOCKS (6 FOLDERS)")
    print(f"Folders: {', '.join(f['pattern'] for f in PHASE_1_FOLDERS)}")
    print(f"Dry run: {dry_run}")
    print(f"{'='*70}\n")

    print("[Phase 1: 1/2] Connecting to Google Drive API...")
    service = get_drive_service()

    print("[Phase 1: 2/2] Initializing Local SigLIP2 768-d Embedder (Hard Gate)...")
    embedder = LocalSigLIP2Embedder()

    phase_start = time.time()
    total_successful = 0
    total_skipped = 0
    total_errors = 0

    for idx, f_cfg in enumerate(PHASE_1_FOLDERS, 1):
        print(f"\n>>> [{idx}/{len(PHASE_1_FOLDERS)}] Processing Folder: {f_cfg['pattern']} (SKU: {f_cfg['sku']})")
        res = run_curated_ingestion(
            folder_like_pattern=f_cfg["pattern"],
            sku_policy="auto",
            default_brand=f_cfg["brand"],
            default_sku=f_cfg["sku"],
            default_category=f_cfg["category"],
            default_space=f_cfg["space"],
            project_hint=f_cfg["hint"],
            batch_prefix=f_cfg["prefix"],
            limit=limit_per_folder,
            dry_run=dry_run,
            service=service,
            embedder=embedder,
        )
        total_successful += res.get("successful", 0)
        total_skipped += res.get("skipped", 0)
        total_errors += res.get("errors", 0)

    phase_time = time.time() - phase_start
    print(f"\n{'='*70}")
    print("PHASE 1 COMPLETE SUMMARY")
    print(f"{'='*70}")
    print(f"Total Successful: {total_successful}")
    print(f"Total Skipped:    {total_skipped}")
    print(f"Total Errors:     {total_errors}")
    print(f"Total Duration:   {phase_time:.1f}s ({phase_time/60:.1f} minutes)")
    print(f"{'='*70}\n")


def run_pilot_c02(limit: Optional[int] = None, dry_run: bool = False):
    """Convenience entry point for Verity C02 Pilot folder."""
    run_curated_ingestion(
        folder_like_pattern="Khóa cổng Verity C02",
        sku_policy="auto",
        default_brand="Verity",
        default_sku="Verity C02",
        default_category="Khóa thông minh",
        default_space="Cửa cổng",
        project_hint="Khóa cổng Verity C02",
        batch_prefix="c02",
        limit=limit,
        dry_run=dry_run,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="1-Pass Curated Importer Orchestrator")
    parser.add_argument("--phase", type=int, choices=[1], default=None, help="Execute specific phase across folders")
    parser.add_argument("--pattern", type=str, default="Khóa cổng Verity C02", help="Folder pattern to match")
    parser.add_argument("--sku", type=str, default=None, help="Explicit SKU (or None)")
    parser.add_argument("--sku-policy", type=str, default="auto", choices=["auto", "folder", "none", "embedding"], help="SKU assignment policy")
    parser.add_argument("--brand", type=str, default="Verity", help="Default brand")
    parser.add_argument("--category", type=str, default="Khóa thông minh", help="Default category")
    parser.add_argument("--space", type=str, default="Cửa cổng", help="Default space")
    parser.add_argument("--batch-prefix", type=str, default=None, help="Batch prefix for storage path and batch_id")
    parser.add_argument("--hint", type=str, default=None, help="Project context hint for AI Vision")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of images")
    parser.add_argument("--dry-run", action="store_true", help="Process locally without pushing to VPS")
    args = parser.parse_args()

    if args.phase == 1:
        run_phase_1(limit_per_folder=args.limit, dry_run=args.dry_run)
    else:
        prefix = args.batch_prefix or (args.sku or args.pattern).lower().replace(" ", "").replace("khoá", "").replace("khóa", "")[:10]
        sku_matcher = RemoteSkuMatcher() if args.sku_policy == "embedding" else None
        try:
            run_curated_ingestion(
                folder_like_pattern=args.pattern,
                sku_policy=args.sku_policy,
                default_brand=args.brand,
                default_sku=args.sku,
                default_category=args.category,
                default_space=args.space,
                project_hint=args.hint,
                batch_prefix=prefix,
                limit=args.limit,
                dry_run=args.dry_run,
                sku_matcher=sku_matcher,
            )
        finally:
            if sku_matcher is not None:
                sku_matcher.close()
