"""Video processing utilities for metadata extraction and thumbnail generation.

Applies media-processing best practices:
- Fast seeking with `-ss` before `-i` for sub-second keyframe extraction.
- Non-blocking timeout guard on all subprocess calls.
- Aspect-ratio preserving Lanczos scaling capped at 1280px.
- Display rotation awareness for mobile recordings (iPhone portrait videos).
"""

from __future__ import annotations

import json
import logging
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

FFMPEG_TIMEOUT_SECONDS = 20


def format_duration(seconds: float | int | None) -> str:
    """Format duration in seconds to standard MM:SS or HH:MM:SS."""
    if seconds is None or not math.isfinite(seconds) or seconds < 0:
        return ""
    total = int(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def is_ffmpeg_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def probe_video_metadata(video_path: Path) -> dict[str, Any]:
    """Extract width, height, and duration using ffprobe."""
    if not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe is not installed on the system")

    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,duration,rotation:stream_tags=rotate:format=duration",
        "-of", "json",
        str(video_path),
    ]

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=True,
            text=True,
        )
        data = json.loads(proc.stdout)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, json.JSONDecodeError) as err:
        logger.warning(f"Failed to probe video {video_path}: {err}")
        return {"width": 0, "height": 0, "duration_seconds": 0.0, "duration": ""}

    width = 0
    height = 0
    rotate = 0
    duration_seconds = 0.0

    streams = data.get("streams", [])
    if streams and isinstance(streams[0], dict):
        vstream = streams[0]
        width = int(vstream.get("width") or 0)
        height = int(vstream.get("height") or 0)
        try:
            duration_seconds = float(vstream.get("duration") or 0)
        except (TypeError, ValueError):
            pass

        # Check rotation tag
        tags = vstream.get("tags") or {}
        rotate_val = tags.get("rotate") or vstream.get("rotation")
        try:
            if rotate_val:
                rotate = abs(int(float(rotate_val)))
        except (TypeError, ValueError):
            pass

    # Fallback to format duration if stream duration is absent
    if duration_seconds <= 0:
        fmt = data.get("format", {})
        try:
            duration_seconds = float(fmt.get("duration") or 0)
        except (TypeError, ValueError):
            pass

    # Swap width & height if portrait video rotated by 90 or 270 degrees
    if rotate in (90, 270) and width > 0 and height > 0:
        width, height = height, width

    return {
        "width": width,
        "height": height,
        "duration_seconds": duration_seconds,
        "duration": format_duration(duration_seconds),
    }


def extract_video_thumbnail(
    video_path: Path,
    output_path: Path,
    target_timestamp: float = 1.0,
) -> bytes:
    """Extract a representative JPEG frame using fast-seeking ffmpeg."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed on the system")

    # Fast seeking: -ss before -i decodes directly from the closest keyframe
    cmd = [
        "ffmpeg",
        "-y",
        "-ss", f"{target_timestamp:.2f}",
        "-i", str(video_path),
        "-vframes", "1",
        "-vf", "scale='min(1280,iw)':-2:flags=lanczos",
        "-q:v", "2",
        str(output_path),
    ]

    try:
        subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Fallback to beginning of video (t=0.0) if timestamp was out of bounds
        fallback_cmd = [
            "ffmpeg",
            "-y",
            "-ss", "0.00",
            "-i", str(video_path),
            "-vframes", "1",
            "-vf", "scale='min(1280,iw)':-2:flags=lanczos",
            "-q:v", "2",
            str(output_path),
        ]
        subprocess.run(
            fallback_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=True,
        )

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg failed to generate thumbnail at {output_path}")

    return output_path.read_bytes()
