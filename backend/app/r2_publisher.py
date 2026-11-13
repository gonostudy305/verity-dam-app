"""Cloudflare R2 writer for the public WordPress rendition only."""

from __future__ import annotations

import hashlib
from io import BytesIO
import time
from typing import Any

from app.production_config import WorkerSettings

try:
    from botocore.exceptions import ClientError
except ImportError:
    class ClientError(Exception):  # type: ignore[no-redef]
        pass


class R2Publisher:
    def __init__(self, settings: WorkerSettings):
        settings.require_r2()
        self.settings = settings
        try:
            import boto3
        except ImportError as error:  # pragma: no cover - deployment configuration failure
            raise RuntimeError("boto3 is required for R2 publication") from error
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name=settings.r2_region,
        )

    def publish(self, key: str, payload: bytes, mime_type: str) -> str:
        assert self.settings.r2_bucket and self.settings.r2_public_base_url
        self.client.upload_fileobj(
            BytesIO(payload),
            self.settings.r2_bucket,
            key,
            ExtraArgs={
                "ContentType": mime_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        return f"{self.settings.r2_public_base_url}/{key}"

    def publish_immutable(self, key: str, payload: bytes, mime_type: str, fingerprint: str = "") -> str:
        """Atomic conditional upload to immutable public key with SHA-256 idempotency check."""
        assert self.settings.r2_bucket and self.settings.r2_public_base_url
        payload_sha256 = hashlib.sha256(payload).hexdigest()
        metadata: dict[str, str] = {
            "verity-sha256": payload_sha256,
        }
        if fingerprint:
            metadata["verity-fingerprint"] = fingerprint

        put_kwargs: dict[str, Any] = {
            "Bucket": self.settings.r2_bucket,
            "Key": key,
            "Body": payload,
            "ContentType": mime_type,
            "CacheControl": "public, max-age=31536000, immutable",
            "Metadata": metadata,
            "IfNoneMatch": "*",
        }

        # Bounded retry for 409 Conflict races
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                self.client.put_object(**put_kwargs)
                return f"{self.settings.r2_public_base_url}/{key}"
            except ClientError as error:
                error_response = error.response.get("Error", {})
                error_code = str(error_response.get("Code") or "")
                http_status = int(error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)

                # 409 Conflict: concurrent race; bounded retry
                if error_code in ("409", "Conflict") or http_status == 409:
                    if attempt < max_attempts - 1:
                        time.sleep(0.1 * (2 ** attempt))
                        continue
                    # Final attempt still 409: short settle, then check if existing object was written
                    time.sleep(0.2)
                    try:
                        return self._verify_existing_immutable(key, payload_sha256)
                    except ClientError as head_err:
                        head_code = str(head_err.response.get("Error", {}).get("Code") or "")
                        head_status = int(head_err.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)
                        if head_code in ("404", "NoSuchKey", "NotFound") or head_status == 404:
                            raise error  # object still not present; propagate original 409 conflict
                        raise

                # 412 PreconditionFailed: object already exists; verify cryptographic hash
                if error_code in ("412", "PreconditionFailed") or http_status == 412:
                    return self._verify_existing_immutable(key, payload_sha256)

                raise

        return self._verify_existing_immutable(key, payload_sha256)

    def _verify_existing_immutable(self, key: str, payload_sha256: str) -> str:
        """Verify that existing object has identical SHA-256; fail closed on hash difference."""
        head = self.client.head_object(Bucket=self.settings.r2_bucket, Key=key)
        existing_meta = head.get("Metadata") or {}
        existing_sha = existing_meta.get("verity-sha256")

        if existing_sha:
            if existing_sha == payload_sha256:
                return f"{self.settings.r2_public_base_url}/{key}"
            raise RuntimeError(
                f"Immutable key conflict: '{key}' already exists with different payload sha256 "
                f"(existing={existing_sha}, new={payload_sha256})"
            )

        # Legacy object without metadata: GET object and compute SHA-256
        obj = self.client.get_object(Bucket=self.settings.r2_bucket, Key=key)
        body_bytes = obj["Body"].read()
        computed_sha = hashlib.sha256(body_bytes).hexdigest()

        if computed_sha == payload_sha256:
            return f"{self.settings.r2_public_base_url}/{key}"

        raise RuntimeError(
            f"Immutable key conflict: '{key}' already exists with different payload sha256 "
            f"(existing={computed_sha}, new={payload_sha256})"
        )

