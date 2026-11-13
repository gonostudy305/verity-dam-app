"""Small PostgreSQL boundary for the native worker runtime."""

from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Sequence
from urllib.parse import urlparse


class PostgresConfigurationError(RuntimeError):
    """Raised when the native PostgreSQL runtime is not safely configured."""


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise PostgresConfigurationError(f"Missing required PostgreSQL setting: {name}")
    return value


@dataclass(frozen=True, repr=False)
class PostgresSettings:
    """Connection settings without exposing a password in repr/log output."""

    database_url: str
    min_connections: int = 1
    max_connections: int = 8
    connect_timeout: int = 10

    def __repr__(self) -> str:
        parsed = urlparse(self.database_url)
        host = parsed.hostname or "unknown"
        database = parsed.path.lstrip("/") or "unknown"
        return (
            "PostgresSettings("
            f"host={host!r}, database={database!r}, "
            f"min_connections={self.min_connections}, max_connections={self.max_connections}, "
            f"connect_timeout={self.connect_timeout})"
        )

    @classmethod
    def from_environment(cls) -> "PostgresSettings":
        database_url = _required_env("DATABASE_URL")
        parsed = urlparse(database_url)
        if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
            raise PostgresConfigurationError(
                "DATABASE_URL must be a PostgreSQL URL (postgres:// or postgresql://)"
            )
        # The VPS database is private inside Docker, so loopback/service-name
        # connections may be plaintext. Any non-local endpoint must explicitly
        # negotiate TLS to prevent accidental credential exposure.
        local_hosts = {"localhost", "127.0.0.1", "::1", "postgres"}
        if parsed.hostname not in local_hosts:
            query = dict(item.split("=", 1) for item in parsed.query.split("&") if "=" in item)
            if query.get("sslmode") not in {"require", "verify-ca", "verify-full"}:
                raise PostgresConfigurationError(
                    "DATABASE_URL for a remote host must include sslmode=require (or stronger)"
                )

        def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
            raw = os.environ.get(name, "").strip()
            if not raw:
                return default
            try:
                value = int(raw)
            except ValueError as error:
                raise PostgresConfigurationError(f"{name} must be an integer") from error
            if not minimum <= value <= maximum:
                raise PostgresConfigurationError(f"{name} must be between {minimum} and {maximum}")
            return value

        minimum = bounded_int("Verity_DB_MIN_CONNECTIONS", 1, 1, 32)
        maximum = bounded_int("Verity_DB_MAX_CONNECTIONS", 8, minimum, 64)
        timeout = bounded_int("Verity_DB_CONNECT_TIMEOUT", 10, 1, 120)
        return cls(database_url, minimum, maximum, timeout)


class PostgresRepository:
    """Thread-safe pooled SQL access for Next/worker migration adapters.

    Queries must always use placeholders and parameters. This class deliberately
    returns ordinary dictionaries so callers are independent of psycopg2 cursor
    implementations and can be ported to psycopg 3 later.
    """

    def __init__(self, settings: PostgresSettings | None = None) -> None:
        self.settings = settings or PostgresSettings.from_environment()
        try:
            import psycopg2.pool
        except ImportError as error:  # pragma: no cover - deployment packaging failure
            raise PostgresConfigurationError("psycopg2-binary is required for PostgreSQL runtime") from error

        self._pool = psycopg2.pool.ThreadedConnectionPool(
            self.settings.min_connections,
            self.settings.max_connections,
            dsn=self.settings.database_url,
            connect_timeout=self.settings.connect_timeout,
        )

    @contextmanager
    def connection(self) -> Iterator[Any]:
        connection = self._pool.getconn()
        try:
            yield connection
        finally:
            # psycopg2 starts an implicit transaction for every statement. Reset
            # pooled connections so a read cannot pin a transaction or leak
            # session state into the next request.
            broken = False
            if not connection.closed:
                try:
                    connection.rollback()
                except Exception:
                    broken = True
            self._pool.putconn(connection, close=broken)

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        """Yield a cursor with a transaction that commits or rolls back safely."""

        with self.connection() as connection:
            try:
                with connection.cursor() as cursor:
                    yield cursor
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def fetch_all(self, query: str, params: Sequence[Any] | Mapping[str, Any] = ()) -> list[dict[str, Any]]:
        with self.connection() as connection:
            from psycopg2.extras import RealDictCursor

            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(query, params)
                return [dict(row) for row in cursor.fetchall()]

    def fetch_one(
        self, query: str, params: Sequence[Any] | Mapping[str, Any] = ()
    ) -> dict[str, Any] | None:
        with self.connection() as connection:
            from psycopg2.extras import RealDictCursor

            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(query, params)
                row = cursor.fetchone()
                return dict(row) if row is not None else None

    def close(self) -> None:
        self._pool.closeall()
