"""SigLIP2 runtime HTTP client adapter -- PREP ONLY, NOT WIRED IN.

Mission S.SIGLIP-FAST Stage B: interface for future P5B production use.
This module is intentionally NOT imported by app/worker.py,
app/native_gateway.py, or any MCP gateway/server code. It does not mutate
any selector, does not write versioned production vectors, and is not
invoked by any production request path.

Capabilities: vision_embed, text_embed, health, identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests


@dataclass
class SigLIP2Embedding:
    space_id: str
    dimension: int
    vector: list[float]


class SigLIP2RuntimeClient:
    """Thin HTTP client for the isolated SigLIP2 staging service.

    Not registered with any embedding-space resolver and not consulted by
    any production read/write path. Exists only so a future, explicitly
    authorized P5B change has a ready-made adapter to wire in.
    """

    def __init__(self, base_url: str, timeout_seconds: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def health(self) -> dict[str, Any]:
        resp = requests.get(f"{self.base_url}/health", timeout=self.timeout_seconds)
        resp.raise_for_status()
        return resp.json()

    def identity(self) -> dict[str, Any]:
        resp = requests.get(f"{self.base_url}/identity", timeout=self.timeout_seconds)
        resp.raise_for_status()
        return resp.json()

    def text_embed(self, text: str) -> SigLIP2Embedding:
        resp = requests.post(
            f"{self.base_url}/embed/text", json={"text": text}, timeout=self.timeout_seconds
        )
        resp.raise_for_status()
        data = resp.json()
        return SigLIP2Embedding(space_id=data["space_id"], dimension=data["dimension"], vector=data["embedding"])

    def vision_embed(self, image_bytes: bytes, content_type: str = "image/jpeg") -> SigLIP2Embedding:
        resp = requests.post(
            f"{self.base_url}/embed/image",
            data=image_bytes,
            headers={"content-type": content_type},
            timeout=self.timeout_seconds,
        )
        resp.raise_for_status()
        data = resp.json()
        return SigLIP2Embedding(space_id=data["space_id"], dimension=data["dimension"], vector=data["embedding"])
