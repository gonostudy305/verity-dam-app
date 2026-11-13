"""Cloudflare R2 object storage boundary for the native PostgreSQL runtime."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse


class R2ConfigurationError(RuntimeError):
    """Raised when R2 cannot be used safely."""


_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


def _https_endpoint(value: str) -> str:
    parsed = urlparse(value.rstrip("/"))
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise R2ConfigurationError("R2_ENDPOINT must be an HTTPS URL without credentials")
    return value.rstrip("/")


@dataclass(frozen=True, repr=False)
class R2Settings:
    endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    region: str = "auto"
    public_base_url: str | None = None

    def __post_init__(self) -> None:
        _https_endpoint(self.endpoint)
        if not self.access_key_id or not self.secret_access_key:
            raise R2ConfigurationError("R2 credentials cannot be empty")
        if not _BUCKET_RE.fullmatch(self.bucket):
            raise R2ConfigurationError("R2_BUCKET contains invalid S3 bucket characters")
        if self.public_base_url:
            _https_endpoint(self.public_base_url)

    def __repr__(self) -> str:
        return (
            "R2Settings("
            f"endpoint={self.endpoint!r}, bucket={self.bucket!r}, region={self.region!r}, "
            f"public_base_url={self.public_base_url!r})"
        )

    @classmethod
    def from_environment(cls) -> "R2Settings":
        endpoint = os.environ.get("R2_ENDPOINT", "").strip()
        if not endpoint:
            raise R2ConfigurationError("Missing required R2 setting: R2_ENDPOINT")
        endpoint = _https_endpoint(endpoint)
        access_key_id = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
        secret_access_key = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
        bucket = os.environ.get("R2_BUCKET", "").strip()
        if not access_key_id or not secret_access_key or not bucket:
            raise R2ConfigurationError(
                "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are required"
            )
        if not _BUCKET_RE.fullmatch(bucket):
            raise R2ConfigurationError("R2_BUCKET contains invalid S3 bucket characters")
        public_base_url = os.environ.get("R2_PUBLIC_BASE_URL", "").strip().rstrip("/") or None
        if public_base_url:
            public_base_url = _https_endpoint(public_base_url)
        return cls(
            endpoint=endpoint,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            bucket=bucket,
            region=os.environ.get("R2_REGION", "auto").strip() or "auto",
            public_base_url=public_base_url,
        )


def _safe_key(key: str) -> str:
    if key != key.strip() or key.startswith("/"):
        raise ValueError("R2 object key must be canonical and relative")
    value = key
    segments = value.split("/")
    if not value or any(segment in {"", ".", ".."} for segment in segments):
        raise ValueError("R2 object key must be non-empty and cannot contain path traversal")
    if "\\" in value or len(value.encode("utf-8")) > 1024 or any(ord(char) < 32 for char in value):
        raise ValueError("R2 object key contains an unsafe character")
    return value


def _safe_expiry(expires_in: int) -> int:
    if not 1 <= expires_in <= 604800:
        raise ValueError("expires_in must be between 1 second and 7 days")
    return expires_in


class R2Storage:
    """S3-compatible R2 client with no public credentials or URLs required."""

    def __init__(self, settings: R2Settings | None = None, client: Any | None = None) -> None:
        self.settings = settings or R2Settings.from_environment()
        if client is not None:
            self.client = client
            return
        try:
            import boto3
        except ImportError as error:  # pragma: no cover - deployment packaging failure
            raise R2ConfigurationError("boto3 is required for Cloudflare R2") from error
        self.client = boto3.client(
            "s3",
            endpoint_url=self.settings.endpoint,
            aws_access_key_id=self.settings.access_key_id,
            aws_secret_access_key=self.settings.secret_access_key,
            region_name=self.settings.region,
        )

    def presign_upload(
        self,
        key: str,
        content_type: str,
        content_length: int,
        *,
        owner_prefix: str,
        expires_in: int = 900,
    ) -> dict[str, Any]:
        object_key = _safe_key(key)
        expires_in = _safe_expiry(expires_in)
        self._assert_scope(object_key, owner_prefix)
        if content_type not in {
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/avif",
            "image/gif",
            "image/heic",
            "image/heif",
            "video/mp4",
            "video/webm",
            "video/quicktime",
        }:
            raise ValueError("content_type is not an allowed image/video MIME type")
        if not isinstance(content_length, int) or content_length < 1:
            raise ValueError("content_length must be a positive integer")
        maximum = 200 * 1024 * 1024 if content_type.startswith("video/") else 50 * 1024 * 1024
        if content_length > maximum:
            raise ValueError("content_length exceeds the allowed media size")
        url = self.client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self.settings.bucket,
                "Key": object_key,
                "ContentType": content_type,
                "ContentLength": content_length,
            },
            ExpiresIn=expires_in,
            HttpMethod="PUT",
        )
        return {"url": url, "method": "PUT", "headers": {"Content-Type": content_type}, "key": object_key}

    def presign_download(self, key: str, *, scope_prefix: str, expires_in: int = 900) -> str:
        object_key = _safe_key(key)
        expires_in = _safe_expiry(expires_in)
        self._assert_scope(object_key, scope_prefix)
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.settings.bucket, "Key": object_key},
            ExpiresIn=expires_in,
            HttpMethod="GET",
        )

    def put_bytes(self, key: str, payload: bytes, content_type: str) -> None:
        object_key = _safe_key(key)
        if not isinstance(payload, bytes):
            raise TypeError("payload must be bytes")
        self.client.put_object(
            Bucket=self.settings.bucket,
            Key=object_key,
            Body=payload,
            ContentType=content_type,
        )

    def get_bytes(self, key: str) -> bytes:
        response = self.client.get_object(Bucket=self.settings.bucket, Key=_safe_key(key))
        body = response["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def delete_object(self, key: str) -> None:
        self.client.delete_object(Bucket=self.settings.bucket, Key=_safe_key(key))

    def public_url(self, key: str) -> str:
        """Return the public CDN URL for ``key`` -- no signature, no expiry.

        Mirrors ``getR2PublicUrl`` in src/lib/server/r2.ts: the app already
        treats the R2 custom domain as public-but-unguessable for every
        media object (public or internal, approved or pending), so this
        follows the same rule rather than inventing a stricter one only for
        Python callers.
        """
        if not self.settings.public_base_url:
            raise R2ConfigurationError("R2_PUBLIC_BASE_URL is required to resolve a public media URL")
        return f"{self.settings.public_base_url}/{_safe_key(key)}"

    @staticmethod
    def _assert_scope(object_key: str, scope_prefix: str) -> None:
        if scope_prefix == "*":
            return
        prefix = _safe_key(scope_prefix).rstrip("/") + "/"
        if not object_key.startswith(prefix):
            raise PermissionError("R2 object key is outside the caller's scope")
