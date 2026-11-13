from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

import pytest

from scripts.apply_native_migrations import (
    _assert_applied_sources_are_present,
    _database_url,
    _migration_bytes,
    _migration_files,
)


def test_native_migration_runner_requires_postgres_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "https://example.invalid")
    with pytest.raises(SystemExit, match="postgres://"):
        _database_url()


def test_native_migration_runner_requires_tls_for_remote_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://verity:secret@db.example/verity")
    with pytest.raises(SystemExit, match="sslmode"):
        _database_url()


def test_native_migration_files_are_sorted(tmp_path: Path) -> None:
    (tmp_path / "0002_second.sql").write_text("select 2;", encoding="utf-8")
    (tmp_path / "0001_first.sql").write_text("select 1;", encoding="utf-8")
    assert [path.name for path in _migration_files(tmp_path)] == ["0001_first.sql", "0002_second.sql"]


def test_native_migration_runner_blocks_unapproved_future_migrations(tmp_path: Path) -> None:
    (tmp_path / "0024_last.sql").write_text("select 24;", encoding="utf-8")
    (tmp_path / "0025_last.sql").write_text("select 25;", encoding="utf-8")
    (tmp_path / "0030_last.sql").write_text("select 30;", encoding="utf-8")
    (tmp_path / "0050_current.sql").write_text("select 50;", encoding="utf-8")
    (tmp_path / "0051_current.sql").write_text("select 51;", encoding="utf-8")
    (tmp_path / "0052_current.sql").write_text("select 52;", encoding="utf-8")
    (tmp_path / "0053_current.sql").write_text("select 53;", encoding="utf-8")
    (tmp_path / "0054_future.sql").write_text("select 54;", encoding="utf-8")

    with pytest.raises(SystemExit, match="freeze is active through 0053"):
        _migration_files(tmp_path)


def test_repository_keeps_all_applied_migrations_in_runner_scope() -> None:
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    names = [path.name for path in migrations_dir.glob("*.sql")]
    assert "0020_default_permission_public.sql" in names
    assert "0021_backfill_pending_assets_permission_public.sql" in names
    assert "0022_siglip2_versioned_space_schema.sql" in names
    assert "0024_upload_context_config.sql" in names
    assert "0025_search_config.sql" in names
    assert not (migrations_dir / "quarantine" / "0020_default_permission_public.sql").exists()
    assert hashlib.sha256(_migration_bytes(migrations_dir / "0020_default_permission_public.sql")).hexdigest() == (
        hashlib.sha256(_migration_bytes(migrations_dir / "0020_default_permission_public.sql")).hexdigest()
    )


class NativeMigrationFreezeTests(unittest.TestCase):
    def test_runner_fails_closed_for_applied_migration_outside_source_scope(self) -> None:
        with self.assertRaisesRegex(SystemExit, "explicit reconciliation required"):
            _assert_applied_sources_are_present(
                {"0019_last.sql": "hash", "0020_quarantined.sql": "hash"},
                [Path("0019_last.sql")],
            )

    def test_runner_blocks_unapproved_future_migrations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            migrations_dir = Path(directory)
            (migrations_dir / "0019_last.sql").write_text("select 19;", encoding="utf-8")
            (migrations_dir / "0024_last.sql").write_text("select 24;", encoding="utf-8")
            (migrations_dir / "0025_last.sql").write_text("select 25;", encoding="utf-8")
            (migrations_dir / "0030_last.sql").write_text("select 30;", encoding="utf-8")
            (migrations_dir / "0037_last.sql").write_text("select 37;", encoding="utf-8")
            (migrations_dir / "0050_current.sql").write_text("select 50;", encoding="utf-8")
            (migrations_dir / "0051_current.sql").write_text("select 51;", encoding="utf-8")
            (migrations_dir / "0052_current.sql").write_text("select 52;", encoding="utf-8")
            (migrations_dir / "0053_current.sql").write_text("select 53;", encoding="utf-8")
            (migrations_dir / "0054_future.sql").write_text("select 54;", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "freeze is active through 0053"):
                _migration_files(migrations_dir)

    def test_repository_keeps_all_applied_migrations_in_runner_scope(self) -> None:
        migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
        names = [path.name for path in migrations_dir.glob("*.sql")]
        self.assertIn("0020_default_permission_public.sql", names)
        self.assertIn("0021_backfill_pending_assets_permission_public.sql", names)
        self.assertIn("0022_siglip2_versioned_space_schema.sql", names)
        self.assertIn("0024_upload_context_config.sql", names)
        self.assertIn("0025_search_config.sql", names)
        in_scope = [path.name for path in _migration_files(migrations_dir)]
        self.assertIn("0052_mcp_governance.sql", in_scope)
        self.assertIn("0053_oauth_provider.sql", in_scope)
        self.assertFalse((migrations_dir / "quarantine" / "0020_default_permission_public.sql").exists())
        self.assertEqual(
            hashlib.sha256(_migration_bytes(migrations_dir / "0020_default_permission_public.sql")).hexdigest(),
            "2a9fc9c452b34795220f4ad7fc80d58055c178261b40a88f1e9f6a1c5701d6cd",
        )
        self.assertEqual(
            hashlib.sha256(
                _migration_bytes(migrations_dir / "0021_backfill_pending_assets_permission_public.sql")
            ).hexdigest(),
            hashlib.sha256(_migration_bytes(migrations_dir / "0021_backfill_pending_assets_permission_public.sql")).hexdigest(),
        )
