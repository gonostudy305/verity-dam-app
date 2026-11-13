from __future__ import annotations

from unittest.mock import Mock, call

import pytest

from app.postgres_repository import PostgresConfigurationError, PostgresSettings
from app.r2_storage import R2ConfigurationError, R2Settings, R2Storage


def test_postgres_settings_requires_native_postgres_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "https://example.invalid")
    with pytest.raises(PostgresConfigurationError, match="PostgreSQL URL"):
        PostgresSettings.from_environment()


def test_postgres_settings_accepts_postgresql_url_without_logging_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://verity:secret@127.0.0.1:5432/verity")
    settings = PostgresSettings.from_environment()
    assert settings.database_url.startswith("postgresql://")
    assert "secret" in settings.database_url
    assert "secret" not in repr(settings)


def test_remote_postgres_requires_tls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://verity:secret@db.example/verity")
    with pytest.raises(PostgresConfigurationError, match="sslmode"):
        PostgresSettings.from_environment()


def test_r2_settings_require_https_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("R2_ENDPOINT", "http://r2.internal")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "access")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("R2_BUCKET", "verity-media")
    with pytest.raises(R2ConfigurationError, match="HTTPS"):
        R2Settings.from_environment()


def test_r2_settings_repr_does_not_include_secret() -> None:
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "access", "secret", "verity-media")
    assert "secret" not in repr(settings)


def test_r2_presigned_upload_and_download_are_s3_compatible() -> None:
    client = Mock()
    client.generate_presigned_url.side_effect = ["https://upload.example", "https://download.example"]
    settings = R2Settings(
        endpoint="https://account.r2.cloudflarestorage.com",
        access_key_id="access",
        secret_access_key="secret",
        bucket="verity-media",
    )
    storage = R2Storage(settings, client=client)

    upload = storage.presign_upload(
        "user/asset.jpg", "image/jpeg", 1234, owner_prefix="user"
    )
    download = storage.presign_download("user/asset.jpg", scope_prefix="user")

    assert upload == {
        "url": "https://upload.example",
        "method": "PUT",
        "headers": {"Content-Type": "image/jpeg"},
        "key": "user/asset.jpg",
    }
    assert download == "https://download.example"
    assert client.generate_presigned_url.call_args_list == [
        call(
            "put_object",
            Params={
                "Bucket": "verity-media",
                "Key": "user/asset.jpg",
                "ContentType": "image/jpeg",
                "ContentLength": 1234,
            },
            ExpiresIn=900,
            HttpMethod="PUT",
        ),
        call(
            "get_object",
            Params={"Bucket": "verity-media", "Key": "user/asset.jpg"},
            ExpiresIn=900,
            HttpMethod="GET",
        ),
    ]


def test_r2_rejects_path_traversal() -> None:
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "a", "s", "verity-media")
    storage = R2Storage(settings, client=Mock())
    with pytest.raises(ValueError, match="path traversal"):
        storage.presign_download("../private.txt", scope_prefix="user")


def test_r2_rejects_expiry_outside_s3_limits() -> None:
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "a", "s", "verity-media")
    storage = R2Storage(settings, client=Mock())
    with pytest.raises(ValueError, match="7 days"):
        storage.presign_download("user/asset.jpg", scope_prefix="user", expires_in=604801)


def test_r2_presign_enforces_owner_scope_and_size() -> None:
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "a", "s", "verity-media")
    storage = R2Storage(settings, client=Mock())
    with pytest.raises(PermissionError, match="scope"):
        storage.presign_upload("other/asset.jpg", "image/jpeg", 100, owner_prefix="user")
    with pytest.raises(ValueError, match="media size"):
        storage.presign_upload("user/asset.jpg", "image/jpeg", 50 * 1024 * 1024 + 1, owner_prefix="user")


def test_r2_get_bytes_closes_streaming_body() -> None:
    body = Mock()
    body.read.return_value = b"image-bytes"
    client = Mock()
    client.get_object.return_value = {"Body": body}
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "a", "s", "verity-media")
    storage = R2Storage(settings, client=client)
    assert storage.get_bytes("user/asset.jpg") == b"image-bytes"
    body.close.assert_called_once_with()


def test_r2_delete_object_targets_the_configured_bucket() -> None:
    client = Mock()
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "a", "s", "verity-media")
    storage = R2Storage(settings, client=client)
    storage.delete_object("_tmp/mcp-embed/abc123")
    client.delete_object.assert_called_once_with(Bucket="verity-media", Key="_tmp/mcp-embed/abc123")


def test_r2_public_url_joins_the_configured_base_and_key() -> None:
    settings = R2Settings(
        "https://account.r2.cloudflarestorage.com", "a", "s", "verity-media",
        public_base_url="https://assets.verity.internal",
    )
    storage = R2Storage(settings, client=Mock())
    assert storage.public_url("user/asset.jpg") == "https://assets.verity.internal/user/asset.jpg"


def test_r2_public_url_requires_a_configured_base() -> None:
    settings = R2Settings("https://account.r2.cloudflarestorage.com", "a", "s", "verity-media")
    storage = R2Storage(settings, client=Mock())
    with pytest.raises(R2ConfigurationError, match="R2_PUBLIC_BASE_URL"):
        storage.public_url("user/asset.jpg")


def test_r2_public_url_rejects_path_traversal() -> None:
    settings = R2Settings(
        "https://account.r2.cloudflarestorage.com", "a", "s", "verity-media",
        public_base_url="https://assets.verity.internal",
    )
    storage = R2Storage(settings, client=Mock())
    with pytest.raises(ValueError, match="path traversal"):
        storage.public_url("../private.txt")
