"""Unit tests for backend/app/video_processing.py."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.video_processing import (
    extract_video_thumbnail,
    format_duration,
    probe_video_metadata,
)


class FormatDurationTests(unittest.TestCase):
    def test_formats_zero_and_sub_minute(self):
        self.assertEqual(format_duration(0), "00:00")
        self.assertEqual(format_duration(15.4), "00:15")
        self.assertEqual(format_duration(59.9), "00:59")

    def test_formats_minutes_and_hours(self):
        self.assertEqual(format_duration(85), "01:25")
        self.assertEqual(format_duration(3600), "01:00:00")
        self.assertEqual(format_duration(3665), "01:01:05")

    def test_handles_none_and_negative(self):
        self.assertEqual(format_duration(None), "")
        self.assertEqual(format_duration(-10), "")


class ProbeVideoMetadataTests(unittest.TestCase):
    @patch("app.video_processing.shutil.which", return_value="/usr/bin/ffprobe")
    @patch("app.video_processing.subprocess.run")
    def test_parses_standard_landscape_video(self, mock_run, mock_which):
        ffprobe_output = {
            "streams": [
                {
                    "width": 1920,
                    "height": 1080,
                    "duration": "12.500000",
                }
            ],
            "format": {"duration": "12.500000"},
        }
        mock_proc = MagicMock()
        mock_proc.stdout = json.dumps(ffprobe_output)
        mock_run.return_value = mock_proc

        result = probe_video_metadata(Path("sample.mp4"))
        self.assertEqual(result["width"], 1920)
        self.assertEqual(result["height"], 1080)
        self.assertEqual(result["duration"], "00:12")
        self.assertEqual(result["duration_seconds"], 12.5)

    @patch("app.video_processing.shutil.which", return_value="/usr/bin/ffprobe")
    @patch("app.video_processing.subprocess.run")
    def test_swaps_width_and_height_for_vertical_rotated_video(self, mock_run, mock_which):
        ffprobe_output = {
            "streams": [
                {
                    "width": 1920,
                    "height": 1080,
                    "duration": "45.000000",
                    "tags": {"rotate": "90"},
                }
            ]
        }
        mock_proc = MagicMock()
        mock_proc.stdout = json.dumps(ffprobe_output)
        mock_run.return_value = mock_proc

        result = probe_video_metadata(Path("iphone_portrait.mov"))
        self.assertEqual(result["width"], 1080)
        self.assertEqual(result["height"], 1920)
        self.assertEqual(result["duration"], "00:45")


class ExtractVideoThumbnailTests(unittest.TestCase):
    @patch("app.video_processing.shutil.which", return_value="/usr/bin/ffmpeg")
    @patch("app.video_processing.subprocess.run")
    def test_invokes_ffmpeg_with_fast_seeking_and_scale(self, mock_run, mock_which):
        with patch.object(Path, "exists", return_value=True), \
             patch.object(Path, "stat") as mock_stat, \
             patch.object(Path, "read_bytes", return_value=b"jpeg-bytes"):
            mock_stat.return_value.st_size = 1234
            data = extract_video_thumbnail(Path("clip.mp4"), Path("out.jpg"), target_timestamp=1.0)
            self.assertEqual(data, b"jpeg-bytes")

            mock_run.assert_called_once()
            cmd = mock_run.call_args[0][0]
            self.assertIn("-ss", cmd)
            self.assertIn("1.00", cmd)
            self.assertIn("-vframes", cmd)


if __name__ == "__main__":
    unittest.main()
