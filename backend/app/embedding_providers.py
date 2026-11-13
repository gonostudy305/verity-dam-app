"""Provider-specific embedding request/response adapters.

``EmbeddingClient`` (see app.embedding_api) owns HTTP retries, image
compression, and vector validation/normalization -- all of that is
provider-agnostic. Everything that actually varies between embedding
gateways -- the request body shape, and how to pull the raw vector out of
the response -- lives here, one small class per provider, so adding a
provider means writing a class and flipping ``Verity_EMBEDDING_PROVIDER``,
not re-deriving another gateway's wire format from scratch inside
EmbeddingClient.

IMPORTANT: verify every shape live against a real account before writing an
adapter. The 2026-08-25 production outage was exactly this mistake: the
worker sent ``{"bytes": ...}`` / ``{"url": ...}`` to 9Router's Jina CLIP v2
endpoint, a shape nobody had actually confirmed the gateway accepted -- the
real contract (``input: [str | TextDoc{text} | ImageDoc{image}]``) was only
found by testing requests directly against the live gateway and reading the
full validation error. Do not add a new provider here from documentation
alone if you can help it -- confirm with one real 200 response first.
"""

from __future__ import annotations

from typing import Any, Protocol


class ProviderError(RuntimeError):
    """Raised when a provider adapter cannot build a request or parse a response."""


class EmbeddingProvider(Protocol):
    """What EmbeddingClient needs from any provider adapter."""

    name: str

    def build_bytes_request(self, *, model: str, dimensions: int, encoded_base64: str) -> dict[str, Any]: ...

    def build_url_request(self, *, model: str, dimensions: int, image_url: str) -> dict[str, Any]: ...

    def extract_vector(self, body: dict[str, Any]) -> list[Any]: ...


class Jina9RouterProvider:
    """9Router's Jina CLIP v2 adapter (https://api.example.com/v1).

    Confirmed live on 2026-08-25 against a real account: ``input`` items are
    ``str | TextDoc{text} | ImageDoc{image}`` -- there is no ``bytes`` or
    ``url`` key on that union. ``ImageDoc.image`` accepts a plain base64
    string, a ``data:`` URI, or an HTTPS URL interchangeably (all three
    produced the identical embedding for the same source image, with
    ``image_tokens`` present in the response). A bare string in ``input`` is
    schema-valid too but is scored as a TextDoc instead -- it silently
    embeds the string itself rather than decoding it as an image -- so this
    adapter never emits that shape.
    """

    name = "jina_9router"

    def build_bytes_request(self, *, model: str, dimensions: int, encoded_base64: str) -> dict[str, Any]:
        return self._request(model=model, dimensions=dimensions, image_value=encoded_base64)

    def build_url_request(self, *, model: str, dimensions: int, image_url: str) -> dict[str, Any]:
        return self._request(model=model, dimensions=dimensions, image_value=image_url)

    def _request(self, *, model: str, dimensions: int, image_value: str) -> dict[str, Any]:
        return {
            "model": model,
            "dimensions": dimensions,
            "normalized": True,
            "embedding_type": "float",
            "input": [{"image": image_value}],
        }

    def extract_vector(self, body: dict[str, Any]) -> list[Any]:
        try:
            return body["data"][0]["embedding"]
        except (KeyError, IndexError, TypeError) as error:
            raise ProviderError("Embedding gateway response has no data[0].embedding") from error


PROVIDERS: dict[str, EmbeddingProvider] = {
    "jina_9router": Jina9RouterProvider(),
}


def get_provider(name: str) -> EmbeddingProvider:
    try:
        return PROVIDERS[name]
    except KeyError as error:
        known = ", ".join(sorted(PROVIDERS)) or "(none registered)"
        raise ProviderError(f"Unknown embedding provider {name!r}; known providers: {known}") from error
