"""Shared error type for worker data adapters."""

from __future__ import annotations


class GatewayError(RuntimeError):
    """A database/object-store boundary operation failed."""

