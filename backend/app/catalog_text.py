"""Bounded text evidence helpers for catalog candidate reranking."""

from __future__ import annotations

import re
from typing import Iterable


_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
MAX_TEXT_VALUES = 8
MAX_TEXT_VALUE_LENGTH = 120
MAX_QUERY_VARIANTS = 80

ECOSYSTEM_PROTOCOLS: frozenset[str] = frozenset({
    "matter",
    "apple home",
    "apple homekit",
    "apple",
    "homekit",
    "works with apple",
    "works with apple home",
    "google home",
    "google assistant",
    "google",
    "alexa",
    "amazon alexa",
    "amazon",
    "zigbee",
    "zigbee 3.0",
    "z-wave",
    "thread",
    "bluetooth",
    "ble",
    "wifi",
    "wi-fi",
    "tera smart",
    "smart life",
})


def sanitize_brand_prior(raw_brand: object) -> str | None:
    """Validate and sanitize a candidate brand before using it as a retrieval prior.

    Ecosystem compatibility badges (e.g. 'Works with Apple Home', 'Matter', 'Zigbee')
    must never be treated as manufacturer brands, which would otherwise pollute
    product retrieval. Returns the cleaned brand string or None.
    """
    if not isinstance(raw_brand, str):
        return None
    cleaned = " ".join(raw_brand.split()).strip()
    if not cleaned or cleaned.casefold() in ECOSYSTEM_PROTOCOLS:
        return None
    lowered = cleaned.casefold()
    for prefix in ("works with ", "hỗ trợ ", "ho tro "):
        if lowered.startswith(prefix):
            return None
    return cleaned


def clean_text_values(values: Iterable[object]) -> list[str]:
    """Keep only short, observable text strings; never invent a model code."""

    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        text = " ".join(value.split())[:MAX_TEXT_VALUE_LENGTH].strip()
        key = text.casefold()
        if not text or key in seen:
            continue
        seen.add(key)
        cleaned.append(text)
        if len(cleaned) >= MAX_TEXT_VALUES:
            break
    return cleaned


def text_query_variants(values: Iterable[object]) -> list[str]:
    """Create exact/short-span lookup variants for product catalog matching."""

    variants: list[str] = []
    seen: set[str] = set()
    for value in clean_text_values(values):
        tokens = [token.casefold() for token in _TOKEN_RE.findall(value)]
        if not tokens:
            continue
        spans = [" ".join(tokens)]
        for width in (4, 3, 2, 1):
            spans.extend(" ".join(tokens[index : index + width]) for index in range(len(tokens) - width + 1))
        for span in spans:
            if len(span) < 2 or span in seen:
                continue
            seen.add(span)
            variants.append(span)
            if len(variants) >= MAX_QUERY_VARIANTS:
                return variants
    return variants


def fuse_sku_candidates(
    image_candidates: Iterable[dict[str, object]],
    text_candidates: Iterable[dict[str, object]],
    *,
    text_boost: float = 0.08,
) -> list[dict[str, object]]:
    """Rerank image candidates with text evidence without changing image scores.

    Text may change ordering among image candidates, but it cannot create an
    auto-accepted SKU on its own. A text-only row is retained at ``-1`` only so
    the reviewer can see the evidence in diagnostics.
    """

    image_by_sku: dict[str, dict[str, object]] = {}
    for candidate in image_candidates:
        sku = candidate.get("sku")
        similarity = candidate.get("similarity")
        if not isinstance(sku, str) or not sku.strip() or not isinstance(similarity, (int, float)):
            continue
        image_by_sku.setdefault(sku.strip(), {"sku": sku.strip(), "similarity": float(similarity)})

    text_by_sku: dict[str, dict[str, object]] = {}
    for candidate in text_candidates:
        sku = candidate.get("sku")
        score = candidate.get("text_score")
        if not isinstance(sku, str) or not sku.strip() or not isinstance(score, (int, float)):
            continue
        text_by_sku[sku.strip()] = {
            "text_score": max(0.0, min(1.0, float(score))),
            "text_evidence": str(candidate.get("text_evidence") or sku.strip())[:200],
        }

    fused: list[dict[str, object]] = []
    for sku, candidate in image_by_sku.items():
        text = text_by_sku.get(sku, {})
        image_score = float(candidate["similarity"])
        score = float(text.get("text_score", 0.0))
        fused.append(
            {
                "sku": sku,
                "similarity": image_score,
                "ranking_score": image_score + (text_boost * score),
                **text,
            }
        )

    for sku, text in text_by_sku.items():
        if sku not in image_by_sku:
            fused.append(
                {
                    "sku": sku,
                    "similarity": -1.0,
                    "ranking_score": -1.0,
                    **text,
                }
            )
    return sorted(fused, key=lambda candidate: (-float(candidate.get("ranking_score", -1)), str(candidate["sku"])))
