"""Server-side multimodal embedding client for the production worker.

The production profile deliberately calls the configured AI gateway instead of
loading CLIP in the worker process. The response is validated before it is
allowed to reach pgvector so a wrong model, dimension, or provider cannot
silently contaminate the production embedding space.

The request/response wire format is provider-specific and lives in
app.embedding_providers, not here -- this client owns only what's the same
regardless of provider: retries/backoff, image compression, HTTPS validation
on a signed URL, and vector validation/normalization.
"""

from __future__ import annotations

import base64
import math
import time
from io import BytesIO
from typing import Any
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps

from app.embedding_providers import ProviderError, get_provider
from app.production_config import PRODUCTION_EMBEDDING_PROFILE, WorkerSettings


class EmbeddingApiError(RuntimeError):
    """Raised when the gateway cannot return a valid production vector."""


EMBEDDING_RETRY_BUDGET_SECONDS = 180.0
EMBEDDING_REQUEST_TIMEOUT_SECONDS = 45.0


class EmbeddingClient:
    """Call one configured OpenAI-compatible multimodal embedding endpoint."""

    def __init__(self, settings: WorkerSettings, session: requests.Session | None = None):
        if settings.embedding_profile not in {PRODUCTION_EMBEDDING_PROFILE, "production_api", "legacy_api"}:
            raise EmbeddingApiError("Production embedding client rejects unknown profiles")
        if not settings.embedding_api_key:
            raise EmbeddingApiError("Production embedding API key is not configured in Settings")
        try:
            self.provider = get_provider(settings.embedding_provider)
        except ProviderError as error:
            raise EmbeddingApiError(str(error)) from error
        self.settings = settings
        self.session = session or requests.Session()

    def embed_image(self, payload: bytes, mime_type: str = "image/jpeg") -> list[float]:
        """Create a normalized vector from image bytes without exposing a storage URL."""
        if not payload:
            raise EmbeddingApiError("Cannot embed an empty image")
        if self.settings.embedding_input_mode == "url":
            raise EmbeddingApiError(
                "Verity_EMBEDDING_INPUT_MODE=url requires embed_image_url"
            )
        resized = _embedding_rendition(payload)
        encoded = base64.b64encode(resized).decode("ascii")
        request_body = self.provider.build_bytes_request(
            model=self.settings.embedding_model,
            dimensions=self.settings.embedding_dimension,
            encoded_base64=encoded,
        )
        return self._request_vector(request_body)

    def embed_image_url(self, image_url: str) -> list[float]:
        """Create a vector from a short-lived HTTPS object URL."""
        parsed = urlparse(image_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise EmbeddingApiError("Embedding image URL must be an HTTPS URL without credentials")
        request_body = self.provider.build_url_request(
            model=self.settings.embedding_model,
            dimensions=self.settings.embedding_dimension,
            image_url=image_url,
        )
        return self._request_vector(request_body)

    def _request_vector(self, request_body: dict[str, Any]) -> list[float]:
        response = None
        max_attempts = 6
        deadline = time.monotonic() + EMBEDDING_RETRY_BUDGET_SECONDS
        for attempt in range(max_attempts):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EmbeddingApiError("Embedding gateway retry budget exhausted")
            try:
                response = self.session.post(
                    f"{self.settings.embedding_base_url}/embeddings",
                    headers={
                        "Authorization": f"Bearer {self.settings.embedding_api_key}",
                        "Content-Type": "application/json",
                    },
                    json=request_body,
                    timeout=min(EMBEDDING_REQUEST_TIMEOUT_SECONDS, remaining),
                )
            except requests.RequestException as error:
                if attempt == max_attempts - 1 or time.monotonic() >= deadline:
                    raise EmbeddingApiError(f"Embedding gateway request failed: {type(error).__name__}") from error
                time.sleep(min(1.0 * (2**attempt), max(0.0, deadline - time.monotonic())))
                continue
            if response.status_code not in {429, 500, 502, 503, 504}:
                break
            if attempt < max_attempts - 1:
                retry_after = 0.0
                try:
                    retry_after = float(response.headers.get("Retry-After", "0"))
                except (AttributeError, TypeError, ValueError):
                    retry_after = 0.0
                sleep_time = max(retry_after, 1.0 if response.status_code == 429 else 0.5 * (2**attempt))
                time.sleep(min(sleep_time, max(0.0, deadline - time.monotonic())))
        assert response is not None
        if response.status_code >= 400:
            detail = _safe_error_detail(response)
            raise EmbeddingApiError(f"Embedding gateway returned HTTP {response.status_code}: {detail}")
        try:
            body = response.json()
        except ValueError as error:
            raise EmbeddingApiError("Embedding gateway returned invalid JSON") from error
        try:
            raw_vector = self.provider.extract_vector(body)
        except ProviderError as error:
            raise EmbeddingApiError(str(error)) from error
        if not isinstance(raw_vector, list) or not raw_vector:
            raise EmbeddingApiError("Embedding gateway returned an empty vector")
        try:
            vector = [float(value) for value in raw_vector]
        except (TypeError, ValueError) as error:
            raise EmbeddingApiError("Embedding gateway returned a non-numeric vector") from error
        if len(vector) != self.settings.embedding_dimension:
            raise EmbeddingApiError(
                f"Embedding dimension mismatch: expected {self.settings.embedding_dimension}, got {len(vector)}"
            )
        if not all(math.isfinite(value) for value in vector):
            raise EmbeddingApiError("Embedding gateway returned a non-finite vector")
        norm = math.sqrt(sum(value * value for value in vector))
        if norm <= 0:
            raise EmbeddingApiError("Embedding gateway returned a zero vector")
        # Some OpenAI-compatible gateways ignore `normalized`; enforce the
        # invariant locally before writing to a cosine-distance index.
        return [value / norm for value in vector]


def _embedding_rendition(payload: bytes, maximum_edge: int = 1024, maximum_bytes: int = 5_000_000) -> bytes:
    """Bound image cost/size while keeping the original asset in Storage."""
    try:
        with Image.open(BytesIO(payload)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((maximum_edge, maximum_edge), Image.Resampling.LANCZOS)
            for quality in (90, 82, 74, 66, 58):
                output = BytesIO()
                image.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
                if output.tell() <= maximum_bytes:
                    return output.getvalue()
    except (OSError, ValueError) as error:
        raise EmbeddingApiError("Image could not be prepared for embedding") from error
    raise EmbeddingApiError("Image remains larger than the embedding request limit after compression")


def _safe_error_detail(response: requests.Response) -> str:
    try:
        body = response.json()
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str):
                    return message[:300]
            if isinstance(error, str):
                return error[:300]
    except ValueError:
        pass
    return response.text[:300]
