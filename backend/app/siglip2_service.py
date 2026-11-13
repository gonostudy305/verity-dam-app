"""SigLIP2 ONNX serving runtime -- ISOLATED STAGING ONLY (Mission S.SIGLIP-FAST Stage B).

GET  /health
POST /embed/image
POST /embed/text
GET  /identity

This is a standalone FastAPI process, not wired into the production worker
or gateway. It is meant to run in an isolated Docker container / staging
host, side by side with (never replacing) the existing OpenCLIP production
service, on a distinct port and container name.

Startup loads both ONNX towers and the tokenizer ONCE (module-level
singleton), matching the "no per-request reload, no dynamic batching"
requirement. Batch stays 1 for every request.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.siglip2_runtime import SIGLIP2_SPACE_ID, SigLIP2ONNXRuntime

logger = logging.getLogger("siglip2_service")

MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MiB oversized-payload guard
ALLOWED_IMAGE_MIME = {"image/jpeg", "image/png", "image/webp"}

app = FastAPI(title="verity-siglip2-runtime-staging", version="0.1.0")

_runtime: SigLIP2ONNXRuntime | None = None
_startup_error: str | None = None


def get_runtime() -> SigLIP2ONNXRuntime:
    global _runtime, _startup_error
    if _runtime is None:
        artifact_dir = os.environ.get("SIGLIP2_ARTIFACT_DIR")
        if not artifact_dir:
            _startup_error = "SIGLIP2_ARTIFACT_DIR environment variable is not set"
            raise RuntimeError(_startup_error)
        try:
            _runtime = SigLIP2ONNXRuntime(Path(artifact_dir))
        except Exception as exc:  # noqa: BLE001
            _startup_error = str(exc)
            raise
    return _runtime


@app.on_event("startup")
def _load_model_once() -> None:
    try:
        get_runtime()
        logger.info("SigLIP2 staging runtime loaded successfully.")
    except Exception as exc:  # noqa: BLE001
        # Do not crash the process at import time; /health will report BLOCK
        # and every endpoint will fail closed with 503 until fixed.
        logger.error("SigLIP2 staging runtime failed to load: %s", exc)


class TextEmbedRequest(BaseModel):
    text: str


@app.get("/health")
def health() -> JSONResponse:
    try:
        runtime = get_runtime()
        return JSONResponse({"status": "ok", "space_id": runtime.space_id})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"status": "error", "detail": str(exc)}, status_code=503)


@app.get("/identity")
def identity() -> dict:
    try:
        runtime = get_runtime()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"runtime not available: {exc}") from exc
    return runtime.identity()


@app.post("/embed/text")
def embed_text(payload: TextEmbedRequest) -> dict:
    try:
        runtime = get_runtime()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"runtime not available: {exc}") from exc
    try:
        vector = runtime.encode_text(payload.text)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "space_id": SIGLIP2_SPACE_ID,
        "dimension": int(vector.shape[0]),
        "embedding": vector.tolist(),
    }


@app.post("/embed/image")
async def embed_image(request: Request) -> dict:
    try:
        runtime = get_runtime()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"runtime not available: {exc}") from exc

    content_type = request.headers.get("content-type", "")
    if content_type not in ALLOWED_IMAGE_MIME:
        raise HTTPException(status_code=415, detail=f"unsupported content-type: {content_type!r}")

    body = await request.body()
    if len(body) == 0:
        raise HTTPException(status_code=400, detail="empty request body")
    if len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"payload too large: {len(body)} bytes > {MAX_IMAGE_BYTES}")

    try:
        vector = runtime.encode_image_bytes(body, max_bytes=MAX_IMAGE_BYTES)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "space_id": SIGLIP2_SPACE_ID,
        "dimension": int(vector.shape[0]),
        "embedding": vector.tolist(),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8801")))
