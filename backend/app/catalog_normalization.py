"""Small, deterministic helpers for catalog identity cleanup.

WooCommerce exports in this project contain both machine-like identifiers and
human-readable model names in the ``sku`` field. We keep the source value for
backward compatibility, but classify it so importers can report the distinction
and product records can store a useful display/model name separately.
"""

from __future__ import annotations

import re
from typing import Any


MACHINE_SKU_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")

# Longest/multi-word names first. Matching is deliberately limited to the
# product title, not the free-form description where supported ecosystems and
# competitor names create false positives. The list mirrors the WooCommerce
# brand taxonomy migration so a missing explicit brand can still be recovered
# from a bounded product title.
CATALOG_BRAND_NAMES: tuple[str, ...] = (
    "LocknLock", "Lock&Lock", "VerityDAM Platform", "Philips Hue", "365 Selection",
    "T3 Smart", "TP-Link", "SwitchBot", "Rover", "Ecolo", "Drift",
    "Levoit", "Orbit", "Lumos", "Acme", "Imex", "Tabo", "EDEN",
    "Philips", "Lyra", "Lockin", "Tera", "UGREEN", "UVGreen", "Anker",
    "Dyson", "Dreamhome", "Kesulo", "Bear", "Lexar", "Nova", "Deerma",
    "Verity", "Joyoung", "SKG", "Eufy", "Govee", "Tenda", "Enchen", "Hikon",
    "Vconnex", "Jisulife", "Tineco", "Mova", "Smartmi", "Breo", "Sandisk",
    "AQUA", "Lumi", "Totolink", "Usmile", "Nanoleaf", "Ruijie", "Wanbo",
    "D-Link", "Ticklock", "Belkin", "Google", "Hoco", "LifeSmart", "ASUS",
    "Kata", "Acerpure", "Goneo", "Kioxia", "Lumias", "Lydsto", "Skyworth",
    "Viomi", "Broadlink", "Laifen", "Mercusys", "Acome", "Botslab",
    "Chint", "Logitech", "Metalock", "Reoqoo", "Amazon", "Arlo", "Bomidi",
    "Ecoflow", "JIUXUN", "Lofans", "Makihome", "Mixie", "Momoda", "OLLI",
    "Rapoo", "Solove", "T3", "Toshiba", "LG",
)

CATALOG_BRAND_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (brand, re.compile(rf"(?<![A-Za-z0-9]){re.escape(brand)}(?![A-Za-z0-9])", re.IGNORECASE))
    for brand in sorted(CATALOG_BRAND_NAMES, key=len, reverse=True)
)

BRAND_ALIASES = {
    "locknlock": "LocknLock",
    "lock&lock": "LocknLock",
    "lock and lock": "LocknLock",
    "lock & lock": "LocknLock",
    "verity": "Verity",
    "verity home appliance": "VerityDAM Platform",
    "tp link": "TP-Link",
    "tp-link": "TP-Link",
    "d_link": "D-Link",
    "d link": "D-Link",
    "eden": "EDEN",
    "philips": "Philips",
    "ugreen": "UGREEN",
    "uvgreen": "UVGreen",
}


def normalize_catalog_sku(value: object) -> str | None:
    """Return a bounded source identifier, preserving spaces for auditability."""

    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 100:
        return None
    if any(char in cleaned for char in ("\n", "\r", "\t", "<", ">", "{", "}", "\\")):
        return None
    return cleaned


def classify_catalog_sku(value: object) -> str:
    """Classify a catalog value without pretending a model name is a SKU code."""

    cleaned = normalize_catalog_sku(value)
    if not cleaned:
        return "missing"
    return "machine_code" if MACHINE_SKU_RE.fullmatch(cleaned) else "model_name"


def infer_catalog_brand(name: object) -> str | None:
    """Infer a brand only from an explicit, bounded product-title match."""

    if not isinstance(name, str):
        return None
    for brand, pattern in CATALOG_BRAND_PATTERNS:
        if pattern.search(name):
            return brand
    return None


def _canonical_brand(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 100:
        return None
    if cleaned.casefold() in {"nobrand", "no brand", "no-brand", "none", "unknown"}:
        return None
    return BRAND_ALIASES.get(cleaned.casefold(), cleaned)


def catalog_brand(product: Any) -> str | None:
    """Read WooCommerce's explicit brand fields before title heuristics."""

    if not isinstance(product, dict):
        return None

    direct = product.get("brands")
    if isinstance(direct, list):
        for item in direct:
            candidate = item.get("name") if isinstance(item, dict) else item
            brand = _canonical_brand(candidate)
            if brand:
                return brand

    attributes = product.get("attributes")
    if isinstance(attributes, list):
        for attribute in attributes:
            if not isinstance(attribute, dict):
                continue
            slug = str(attribute.get("slug") or "").casefold()
            label = str(attribute.get("name") or "").casefold()
            if slug not in {"pa_brands", "pa_brand", "brand"} and label not in {"brand", "thương hiệu"}:
                continue
            options = attribute.get("options")
            if isinstance(options, list):
                for option in options:
                    brand = _canonical_brand(option)
                    if brand:
                        return brand

    return infer_catalog_brand(product.get("name"))
