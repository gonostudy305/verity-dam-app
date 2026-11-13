"""Canonical OpenCLIP validation preprocessing implementation (NumPy/PIL).

Matches upstream torchvision.transforms.Resize(256, interpolation=BICUBIC, antialias=True) + CenterCrop(256) exact math:
1. Resize: new_short = 256, new_long = int(256 * long / short)
2. CenterCrop: crop_top = int(round((new_h - 256) / 2.0)), crop_left = int(round((new_w - 256) / 2.0))
3. RGB rescale to [0.0, 1.0].
4. Channel-wise normalize: (x - mean) / std.
5. Shape: (1, 3, 256, 256), float32, NCHW.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

OPENCLIP_TARGET_SIZE = 256
OPENCLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32).reshape(1, 3, 1, 1)
OPENCLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32).reshape(1, 3, 1, 1)


def canonical_openclip_preprocess(image: Image.Image) -> np.ndarray:
    """Preprocess PIL Image matching official open_clip / torchvision preprocess_val."""
    rgb = image.convert("RGB")
    w, h = rgb.size

    # Torchvision exact integer truncation for resize
    if w < h:
        new_w = OPENCLIP_TARGET_SIZE
        new_h = int(OPENCLIP_TARGET_SIZE * h / w)
    else:
        new_h = OPENCLIP_TARGET_SIZE
        new_w = int(OPENCLIP_TARGET_SIZE * w / h)

    resized = rgb.resize((new_w, new_h), Image.Resampling.BICUBIC)

    # Torchvision CenterCrop exact integer coordinates
    crop_top = int(round((new_h - OPENCLIP_TARGET_SIZE) / 2.0))
    crop_left = int(round((new_w - OPENCLIP_TARGET_SIZE) / 2.0))
    cropped = resized.crop((crop_left, crop_top, crop_left + OPENCLIP_TARGET_SIZE, crop_top + OPENCLIP_TARGET_SIZE))

    # Convert to float32 array in [0.0, 1.0], NCHW
    arr = np.array(cropped, dtype=np.float32) / 255.0
    arr = np.transpose(arr, (2, 0, 1))
    arr = np.expand_dims(arr, 0)

    # Standard channel-wise normalization
    normalized = (arr - OPENCLIP_MEAN) / OPENCLIP_STD
    return normalized.astype(np.float32)
