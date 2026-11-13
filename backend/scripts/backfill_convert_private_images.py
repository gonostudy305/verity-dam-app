"""Backfill existing private R2 images (PNG, HEIF, HEIC, AVIF, GIF) to WebP.

Converts full-resolution images to WebP format (quality 82, method 4, no resizing)
to optimize storage space in private R2 while keeping full detail.

Usage:
  python -m scripts.backfill_convert_private_images --dry-run
  python -m scripts.backfill_convert_private_images --confirm
"""

from __future__ import annotations

import argparse
from io import BytesIO
import json
import re
import sys
import time
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

from app.native_gateway import NativeGateway
from app.production_config import WorkerSettings


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert non-WebP/non-JPEG private R2 images to WebP")
    parser.add_argument("--dry-run", action="store_true", help="Inspect and measure candidates without modifying R2 or DB")
    parser.add_argument("--confirm", action="store_true", help="Execute conversion and R2/DB updates")
    parser.add_argument("--limit", type=int, default=100, help="Maximum assets to process in one run")
    return parser.parse_args()


def convert_image_to_webp(payload: bytes) -> tuple[bytes, int, int]:
    """Converts image payload to WebP at quality 82, preserving original dimensions and orientation."""
    with Image.open(BytesIO(payload)) as source:
        img = ImageOps.exif_transpose(source).convert("RGB")
        width, height = img.size
        out = BytesIO()
        img.save(out, format="WEBP", quality=82, method=4)
        return out.getvalue(), width, height


def run_backfill() -> None:
    args = parse_arguments()
    is_live = bool(args.confirm and not args.dry_run)

    print("=" * 70)
    print(f"Verity Private R2 Image Optimization Backfill (Mode: {'LIVE' if is_live else 'DRY RUN'})")
    print("=" * 70)

    settings = WorkerSettings.from_environment()
    gateway = NativeGateway(settings)

    candidates = gateway.repository.fetch_all(
        """
        SELECT id, storage_path, file_url, thumbnail_path, thumbnail_url, dimensions
        FROM public.media_assets
        WHERE deleted_at IS NULL
          AND (
            right(storage_path, 4) IN ('.png', '.gif')
            OR right(storage_path, 5) IN ('.heif', '.heic', '.avif')
          )
        ORDER BY created_at ASC
        LIMIT %s;
        """,
        (args.limit,),
    )

    print(f"Found {len(candidates)} candidate asset(s) to optimize.")
    if not candidates:
        print("All assets are already optimized. Exiting.")
        return

    total_old_bytes = 0
    total_new_bytes = 0
    converted_count = 0
    failed_count = 0

    for idx, asset in enumerate(candidates, 1):
        asset_id = str(asset["id"])
        old_storage_path = str(asset["storage_path"] or "")
        dims = asset.get("dimensions") or {}
        if not isinstance(dims, dict):
            dims = {}

        print(f"\n[{idx}/{len(candidates)}] Processing asset {asset_id}:")
        print(f"  Old path: {old_storage_path}")

        try:
            # 1. Download original
            raw_bytes = gateway.storage.get_bytes(old_storage_path)
            old_size = len(raw_bytes)
            total_old_bytes += old_size

            # 2. Convert to WebP
            webp_bytes, width, height = convert_image_to_webp(raw_bytes)
            new_size = len(webp_bytes)
            total_new_bytes += new_size
            saved_pct = ((old_size - new_size) / old_size) * 100 if old_size else 0

            # 3. New storage path
            new_storage_path = re.sub(r"\.[a-zA-Z0-9]+$", ".webp", old_storage_path)
            if new_storage_path == old_storage_path:
                new_storage_path = f"{old_storage_path}.webp"

            print(f"  Converted: {width}x{height} | {old_size:,} bytes -> {new_size:,} bytes ({saved_pct:.1f}% saved)")
            print(f"  New path: {new_storage_path}")

            if not is_live:
                print("  [DRY RUN] Skipping R2 upload and DB update.")
                converted_count += 1
                continue

            # 4. Upload converted WebP to R2
            gateway.storage.put_bytes(new_storage_path, webp_bytes, "image/webp")

            # 5. Update database
            updated_dims = dict(dims)
            updated_dims["width"] = width
            updated_dims["height"] = height
            updated_dims["size_bytes"] = new_size
            updated_dims["mime_type"] = "image/webp"

            with gateway.repository.transaction() as cursor:
                cursor.execute(
                    """
                    UPDATE public.media_assets
                    SET storage_path = %s,
                        file_url = CASE WHEN file_url = %s THEN %s ELSE file_url END,
                        thumbnail_path = CASE WHEN thumbnail_path = %s THEN %s ELSE thumbnail_path END,
                        thumbnail_url = CASE WHEN thumbnail_url = %s THEN %s ELSE thumbnail_url END,
                        dimensions = %s::jsonb,
                        updated_at = NOW()
                    WHERE id = %s;
                    """,
                    (
                        new_storage_path,
                        old_storage_path,
                        new_storage_path,
                        old_storage_path,
                        new_storage_path,
                        old_storage_path,
                        new_storage_path,
                        json.dumps(updated_dims),
                        asset_id,
                    ),
                )

            # 6. Delete old object from R2 (freeing up private storage)
            try:
                gateway.storage.delete_object(old_storage_path)
                print("  Deleted old object from R2 successfully.")
            except Exception as del_err:
                print(f"  Warning: failed to delete old object {old_storage_path}: {del_err}")

            print("  Successfully updated asset record.")
            converted_count += 1

        except Exception as err:
            failed_count += 1
            print(f"  ERROR processing asset {asset_id}: {type(err).__name__}: {err}")

    print("\n" + "=" * 70)
    print("BACKFILL SUMMARY:")
    print(f"  Candidates: {len(candidates)}")
    print(f"  Converted:  {converted_count}")
    print(f"  Failed:     {failed_count}")
    if total_old_bytes > 0:
        total_saved = total_old_bytes - total_new_bytes
        total_saved_pct = (total_saved / total_old_bytes) * 100
        print(f"  Original size:  {total_old_bytes:,} bytes ({total_old_bytes / 1024 / 1024:.2f} MB)")
        print(f"  Converted size: {total_new_bytes:,} bytes ({total_new_bytes / 1024 / 1024:.2f} MB)")
        print(f"  Storage saved:  {total_saved:,} bytes ({total_saved / 1024 / 1024:.2f} MB / {total_saved_pct:.1f}%)")
    print("=" * 70)


if __name__ == "__main__":
    run_backfill()
