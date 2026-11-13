"""Resolve SKU and model name aliases via verity_products.aliases.

Maps a human model name (e.g. 'Acme A100') to canonical machine code(s) (e.g. ['AC-S02']),
or maps a machine code to its model name(s), by querying verity_products.
"""

from __future__ import annotations

from typing import Any, Sequence


def resolve_sku_aliases(gateway: Any, sku: str) -> list[str]:
    """Return all known aliases and the SKU itself, deduplicated.

    Args:
        gateway: NativeGateway or any object with _fetch_all(query, params)
        sku: Target SKU or model name (e.g. 'Acme A100' or 'AC-S02')

    Returns:
        List of strings containing the original SKU plus any linked aliases or primary SKUs.
    """
    cleaned = (sku or "").strip()
    if not cleaned:
        return []

    try:
        rows = gateway._fetch_all(
            """
            select primary_sku, aliases
            from public.verity_products
            where primary_sku = %s or %s = any(aliases)
            """,
            (cleaned, cleaned),
        )
    except Exception:
        return [cleaned]

    results: set[str] = {cleaned}
    for row in rows:
        if isinstance(row, dict):
            p_sku = row.get("primary_sku")
            aliases = row.get("aliases")
        else:
            p_sku = row[0] if len(row) > 0 else None
            aliases = row[1] if len(row) > 1 else None

        if isinstance(p_sku, str) and p_sku.strip():
            results.add(p_sku.strip())
        if isinstance(aliases, (list, tuple)):
            for a in aliases:
                if isinstance(a, str) and a.strip():
                    results.add(a.strip())

    return sorted(results)


def resolve_sku_group_for_matching(gateway: Any, sku_candidates: Sequence[str]) -> dict[str, str]:
    """Map any candidate alias back to its canonical primary_sku.

    Given a list of matched SKUs (e.g. ['AC-S02']), maps them to their
    preferred display/primary product SKU if available.
    """
    if not sku_candidates:
        return {}

    mapping: dict[str, str] = {}
    try:
        rows = gateway._fetch_all(
            """
            select primary_sku, aliases
            from public.verity_products
            where primary_sku = any(%s::text[]) or aliases && %s::text[]
            """,
            (list(sku_candidates), list(sku_candidates)),
        )
        for row in rows:
            p_sku = row.get("primary_sku") if isinstance(row, dict) else row[0]
            aliases = row.get("aliases") if isinstance(row, dict) else row[1]
            if isinstance(p_sku, str) and p_sku.strip():
                canonical = p_sku.strip()
                mapping[canonical] = canonical
                if isinstance(aliases, (list, tuple)):
                    for a in aliases:
                        if isinstance(a, str) and a.strip():
                            mapping[a.strip()] = canonical
    except Exception:
        pass

    return mapping
