#!/usr/bin/env python3
"""Download pinned SigLIP2 ONNX model artifacts from an object-storage/CDN location you control.

Set ``VERITY_MODELS_CDN_URL`` to the base URL that hosts the two files below.

Saves artifacts directly into ``backend/benchmarks/models/``:
- siglip2-vision-opset18.onnx (1.2 MB)
- siglip2-vision-opset18.onnx.data (360.8 MB)
"""

from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

R2_MODELS_BASE = os.environ.get("VERITY_MODELS_CDN_URL", "").strip()

REPO_ROOT = Path(__file__).resolve().parents[2]
TARGET_DIRS = [
    REPO_ROOT / "backend" / "benchmarks" / "models",
    REPO_ROOT / "backend" / "models",
]
MODEL_FILES = [
    ("siglip2-vision-opset18.onnx", 1225533),
    ("siglip2-vision-opset18.onnx.data", 378273792),
]


def download_progress(block_num: int, block_size: int, total_size: int) -> None:
    downloaded = block_num * block_size
    if total_size > 0:
        percent = min(100.0, downloaded * 100.0 / total_size)
        mb_down = downloaded / (1024 * 1024)
        mb_total = total_size / (1024 * 1024)
        sys.stdout.write(f"\r  Progress: {percent:5.1f}% ({mb_down:5.1f} / {mb_total:5.1f} MB)")
        sys.stdout.flush()


def main() -> int:
    import shutil

    if not R2_MODELS_BASE:
        print(
            "VERITY_MODELS_CDN_URL is not set. Host the SigLIP2 ONNX files "
            "(see MODEL_FILES) on storage you control and export its base URL, "
            "or copy them into backend/models/ manually.",
            file=sys.stderr,
        )
        return 2

    primary_dir = TARGET_DIRS[0]
    secondary_dir = TARGET_DIRS[1]
    primary_dir.mkdir(parents=True, exist_ok=True)
    secondary_dir.mkdir(parents=True, exist_ok=True)
    print(f"Ensuring SigLIP2 ONNX model artifacts in: {primary_dir} and {secondary_dir}")

    for filename, expected_size in MODEL_FILES:
        p_path = primary_dir / filename
        s_path = secondary_dir / filename

        # Check if already present in primary
        if not (p_path.exists() and p_path.stat().st_size == expected_size):
            if s_path.exists() and s_path.stat().st_size == expected_size:
                print(f"Copying {filename} from {secondary_dir} to {primary_dir}...")
                shutil.copy2(str(s_path), str(p_path))
            else:
                url = R2_MODELS_BASE.rstrip("/") + "/" + filename
                print(f"\nDownloading {filename} from {url}...")
                try:
                    urllib.request.urlretrieve(url, str(p_path), reporthook=download_progress)
                    print(f"\n✓ Downloaded {filename} successfully.")
                except Exception as e:
                    print(f"\n✗ Error downloading {filename}: {e}")
                    return 1

        # Synchronize to secondary if missing
        if not (s_path.exists() and s_path.stat().st_size == expected_size):
            print(f"Synchronizing {filename} to {secondary_dir}...")
            shutil.copy2(str(p_path), str(s_path))

        print(f"✓ {filename} verified in both model directories ({expected_size:,} bytes).")

    print("\nAll SigLIP2 ONNX model files are synchronized and ready for embedding inference!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
