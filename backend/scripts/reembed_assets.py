"""Move already-analysed media assets into the production embedding space.

Usage:
  python -m scripts.reembed_assets --dry-run            # measure only, writes nothing
  python -m scripts.reembed_assets --limit 5 --confirm
  python -m scripts.reembed_assets --confirm

Run this AFTER the native embedding provenance migration is applied: the
provenance columns it adds are what this script filters and writes. Until an
asset is re-embedded its stored vector is stamped ``legacy_local_clip`` and
``match_scene_duplicate_candidates`` skips it, so scene de-duplication runs on
pHash alone for that asset.

Rollback: every overwritten vector is appended to the backup JSONL *before* the
update, so the previous state can be restored from that file. A dedicated
``image_embedding_prev`` column was deliberately not added -- permanent schema
weight for a one-time backfill is a worse trade than a transient file.

The script never imports local CLIP and refuses to run under that profile.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# A Windows console defaults to cp1252 and cannot encode Vietnamese, which would
# crash the backfill on a progress line rather than on a real failure.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.embedding_api import EmbeddingClient
from app.production_config import WorkerSettings
from app.shared_embedding_config import apply_shared_embedding_config
from app.native_gateway import NativeGateway


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Re-embed media assets into the production space")
    parser.add_argument("--limit", type=int, default=500, help="Maximum assets to process (default 500)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Download and embed but never write; use this to measure the cutover window",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Allow production vector writes. Without this flag the command is always a dry-run.",
    )
    parser.add_argument(
        "--backup",
        default="reembed_assets_backup.jsonl",
        help="Where to append replaced vectors before overwriting (default ./reembed_assets_backup.jsonl)",
    )
    parser.add_argument(
        "--log",
        default="reembed_assets_log.jsonl",
        help="Per-asset outcome log (default ./reembed_assets_log.jsonl)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_arguments()
    if args.limit < 1:
        raise SystemExit("--limit must be at least 1")

    settings = WorkerSettings.from_environment()
    gateway = NativeGateway(settings)
    embedding_settings = apply_shared_embedding_config(settings, gateway.shared_embedding_config())
    embedding_client = EmbeddingClient(embedding_settings)

    pending = gateway.list_assets_outside_embedding_space(limit=args.limit)
    if not pending:
        print("Không có asset nào nằm ngoài không gian embedding production. Không cần làm gì.")
        return

    if not args.confirm:
        args.dry_run = True
    mode = "CHẠY THỬ (không ghi)" if args.dry_run else "GHI THẬT"
    print(f"=== {mode}: {len(pending)} asset cần re-embed sang jina-clip-v2 ===")

    backup_path = Path(args.backup)
    log_path = Path(args.log)
    succeeded = 0
    failed = 0
    latencies: list[float] = []

    for index, asset in enumerate(pending, 1):
        asset_id = str(asset.get("id") or "")
        storage_path = asset.get("storage_path")
        if not asset_id or not isinstance(storage_path, str) or not storage_path:
            failed += 1
            print(f"  [!] Asset {asset_id or '<không có id>'} thiếu storage_path, bỏ qua")
            continue

        started = time.monotonic()
        try:
            payload = gateway.download_object(storage_path)
            embedding = embedding_client.embed_image(payload)
            elapsed = time.monotonic() - started
            latencies.append(elapsed)

            if not args.dry_run:
                previous = gateway.get_asset_embedding(asset_id)
                with backup_path.open("a", encoding="utf-8") as backup:
                    backup.write(
                        json.dumps(
                            {
                                "media_asset_id": asset_id,
                                "embedding_provider": asset.get("embedding_provider"),
                                "embedding_model": asset.get("embedding_model"),
                                "image_embedding": previous,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                gateway.update_asset_embedding(asset_id, embedding)

            succeeded += 1
            outcome = {"media_asset_id": asset_id, "ok": True, "seconds": round(elapsed, 3)}
        except Exception as error:  # noqa: BLE001 - one bad asset must not stop the backfill
            failed += 1
            outcome = {
                "media_asset_id": asset_id,
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
                "seconds": round(time.monotonic() - started, 3),
            }
            print(f"  [!] Asset {asset_id}: {type(error).__name__}: {error}")

        with log_path.open("a", encoding="utf-8") as log:
            log.write(json.dumps(outcome, ensure_ascii=False) + "\n")

        if index % 25 == 0 or index == len(pending) or index <= 5:
            print(f"[{index:4d}/{len(pending)}] thành công {succeeded}, lỗi {failed}")

    print(f"\nHoàn tất: {succeeded} thành công, {failed} lỗi.")
    if latencies:
        average = sum(latencies) / len(latencies)
        print(f"Độ trễ trung bình mỗi ảnh: {average:.2f}s (nhanh nhất {min(latencies):.2f}s, chậm nhất {max(latencies):.2f}s)")
        print(f"Ngoại suy cho 3.081 reference catalog: khoảng {average * 3081 / 60:.0f} phút nếu chạy tuần tự.")
    if not args.dry_run and succeeded:
        print(f"Vector cũ đã lưu để rollback tại: {backup_path}")


if __name__ == "__main__":
    main()
