from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.native_gateway import NativeGateway
from app.production_config import WorkerSettings
from app.worker import MediaWorker


def _settings(**overrides) -> WorkerSettings:
    values = dict(
        worker_id="native-test",
        poll_seconds=3,
        scene_duplicate_threshold=0.92,
        phash_max_distance=12,
        embedding_profile="production_api",
        embedding_provider="jina_9router",
        embedding_base_url="https://api.example.com/v1",
        embedding_api_key="",
        embedding_model="jina-ai/jina-clip-v2",
        embedding_version="jina-clip-v2-v1",
        embedding_dimension=512,
        embedding_input_mode="bytes",
        vision_base_url=None,
        vision_api_key=None,
        vision_model=None,
        vision_detail="high",
        vision_max_tokens=900,
        vision_system_prompt="",
        r2_endpoint="https://account.r2.cloudflarestorage.com",
        r2_access_key_id="access",
        r2_secret_access_key="secret",
        r2_bucket="verity-media",
        r2_region="auto",
        r2_public_base_url=None,
        database_url="postgresql://verity:password@postgres/verity_media",
    )
    values.update(overrides)
    return WorkerSettings(**values)


def test_database_url_selects_native_backend(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://verity:secret@postgres/verity_media")
    monkeypatch.setenv("R2_ENDPOINT", "https://account.r2.cloudflarestorage.com")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "access")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("R2_BUCKET", "verity-media")

    settings = WorkerSettings.from_environment()

    assert settings.database_url.startswith("postgresql://")


def test_native_gateway_reads_source_bytes_from_r2():
    repository = MagicMock()
    storage = MagicMock()
    storage.get_bytes.return_value = b"image"
    gateway = NativeGateway(_settings(), repository=repository, storage=storage)

    assert gateway.download_object("owner/asset.jpg") == b"image"
    storage.get_bytes.assert_called_once_with("owner/asset.jpg")


def test_native_sku_matching_uses_primary_weighted_production_ranking():
    repository = MagicMock()
    repository.fetch_all.return_value = []
    gateway = NativeGateway(_settings(), repository=repository, storage=MagicMock())

    assert gateway.match_sku_reference_candidates("[0.0,0.1]", 20) == []

    query = repository.fetch_all.call_args.args[0]
    assert "raw_candidates" in query
    assert "s.similarity" in query
    # Post-0022 the SKU match filters the versioned reference_embeddings table
    # (alias re), not the sku_references row (alias r); see commit 83b0738.
    assert "re.space_id = %s" in query
    assert "embedding_provider = %s" not in query


def test_worker_selects_native_gateway_for_database_settings():
    native = MagicMock()
    with patch("app.worker.NativeGateway", return_value=native) as constructor:
        worker = MediaWorker(_settings())

    constructor.assert_called_once()
    assert worker.gateway is native
