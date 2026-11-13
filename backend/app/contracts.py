"""Pure production contracts shared by the asynchronous media worker.

The important boundary in this module is intentional: an SKU can only be
created by ``gate_sku_candidates`` from production embedding reference
similarities. Vision
metadata is parsed by a different function and has no ``sku`` field.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from typing import Any, Iterable

# Calibrated against the native Jina CLIP v2 production space (1,398
# same-SKU pairs: P10=.7564/P50=.9027; nearest other-SKU P10=.8390).  The old
# CLIP thresholds let a visually similar neighbouring product auto-fill at
# .85, so the high band is deliberately precision-first and tied results are
# sent to review.  Re-run calibrate_thresholds.py after a catalog refresh.
SKU_HIGH_CONFIDENCE = 0.90
SKU_LOW_CONFIDENCE = 0.70
SKU_AMBIGUITY_MARGIN = 0.08

# Multi-Vector Consistency Gate -- closes the "open-world k-NN" hole: a photo of
# a SKU with zero reference embeddings still returns a confident-looking top-1
# from some unrelated SKU, because pure nearest-neighbour search always returns
# *something*. A genuine match scores high on every reference image of the
# winning SKU; a spurious one usually got lucky on exactly one angle. Validated
# 2026-08-24 on 3 real cases (see gate_sku_candidates callers in worker.py):
#   Match GIA  (Tabo->Imex IPC-A42P-D):  sims=[0.8829, 0.7679] spread=0.1150
#   Match THAT (Imex that->IPC-A42P-D):  sims=[0.8655, 0.8235] spread=0.0419
#   Match THAT (Levoit->LAP-C161-AEUR):  sims=[0.9462, 0.9149, 0.8896] spread=0.0566
SKU_CONSISTENCY_PRIMARY_MIN = 0.80
SKU_CONSISTENCY_SPREAD_MAX = 0.15

_METADATA_TEXT_LIMITS = {
    "caption": 2_000,
    "description": 4_000,
    "brand": 200,
    "category": 200,
    "space": 200,
    "status": 200,
}
_ALLOWED_SHOT_TYPES = frozenset({
    "front",
    "angle",
    "top_down",
    "closeup",
    "wide",
    "lifestyle",
})
_METADATA_CONFIDENCE_KEYS = {
    "visible_text_confidence",
    "brand_confidence",
    "category_confidence",
    "space_confidence",
    "status_confidence",
}


@dataclass(frozen=True)
class SkuDecision:
    sku: str | None
    confidence_band: str
    similarity: float
    runner_up_similarity: float | None
    margin: float | None
    ambiguity_warning: bool
    requires_reviewer_confirmation: bool
    candidates: tuple[dict[str, float | str], ...]
    consistency_note: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": "embedding_reference",
            "sku": self.sku,
            "confidence_band": self.confidence_band,
            "similarity": self.similarity,
            "runner_up_similarity": self.runner_up_similarity,
            "margin": self.margin,
            "ambiguity_warning": self.ambiguity_warning,
            "requires_reviewer_confirmation": self.requires_reviewer_confirmation,
            "consistency_note": self.consistency_note,
            "thresholds": {
                "high": SKU_HIGH_CONFIDENCE,
                "low": SKU_LOW_CONFIDENCE,
                "ambiguity_margin": SKU_AMBIGUITY_MARGIN,
                "consistency_primary_min": SKU_CONSISTENCY_PRIMARY_MIN,
                "consistency_spread_max": SKU_CONSISTENCY_SPREAD_MAX,
            },
            "candidates": list(self.candidates),
        }


def _normalise_candidates(candidates: Iterable[dict[str, Any]]) -> list[dict[str, float | str]]:
    """Keep the first/best reference entry per SKU, preserving RPC ranking order."""
    seen: set[str] = set()
    normalized: list[dict[str, float | str]] = []
    for candidate in candidates:
        sku = candidate.get("sku")
        similarity = candidate.get("similarity")
        if not isinstance(sku, str) or not sku.strip():
            continue
        if not isinstance(similarity, (float, int)):
            continue
        key = sku.strip()
        if key in seen:
            continue
        seen.add(key)
        score = min(1.0, max(-1.0, float(similarity)))
        normalized_candidate: dict[str, float | str] = {"sku": key, "similarity": score}
        for extra_key in ("ranking_score", "text_score", "text_evidence"):
            extra = candidate.get(extra_key)
            if isinstance(extra, (float, int, str)):
                normalized_candidate[extra_key] = float(extra) if isinstance(extra, (float, int)) else extra
        normalized.append(normalized_candidate)
    return normalized


def gate_sku_candidates(candidates: Iterable[dict[str, Any]]) -> SkuDecision:
    """Apply Verity's embedding-reference-only SKU gates.

    A low-confidence result is retained as a visibly review-required proposal;
    an unmatched result deliberately has ``sku=None``.  The margin warning is
    independent from confidence so an apparently strong but tied result remains
    debuggable.
    """
    ranked = _normalise_candidates(candidates)
    if not ranked:
        return SkuDecision(None, "unmatched", 0.0, None, None, False, True, ())

    winner = ranked[0]
    score = float(winner["similarity"])
    runner_up = float(ranked[1]["similarity"]) if len(ranked) > 1 else None
    margin = score - runner_up if runner_up is not None else None
    ambiguous = margin is not None and margin < SKU_AMBIGUITY_MARGIN
    retained = tuple(ranked[:5])

    if score < SKU_LOW_CONFIDENCE:
        return SkuDecision(None, "unmatched", score, runner_up, margin, ambiguous, True, retained)
    if score < SKU_HIGH_CONFIDENCE:
        return SkuDecision(str(winner["sku"]), "low", score, runner_up, margin, ambiguous, True, retained)
    return SkuDecision(
        str(winner["sku"]),
        "high",
        score,
        runner_up,
        margin,
        ambiguous,
        ambiguous,
        retained,
    )


def apply_consistency_gate(
    decision: SkuDecision,
    reference_similarities: list[float],
    primary_similarity: float | None,
) -> SkuDecision:
    """Cross-check a "high" verdict against every reference image of the winning
    SKU before it is allowed to auto-fill. Callers must fetch and score the
    candidate SKU's own reference embeddings themselves -- this stays pure and
    only judges numbers it is handed.

    Only ``confidence_band == "high"`` is at risk here: "low" and "unmatched"
    already route to a reviewer, so a spurious low-confidence hit is already
    safe. A "high" decision downgraded by this gate becomes "low" and forces
    reviewer confirmation, exactly like a naturally low-confidence match --
    it never gets hidden, only demoted.
    """
    if decision.confidence_band != "high":
        return decision

    if not reference_similarities:
        # A SKU that just won gate_sku_candidates must have >=1 reference row
        # by construction (that's where its similarity score came from), so
        # this should not happen -- but refuse to auto-fill on a data gap
        # rather than assume it is safe.
        return replace(
            decision,
            confidence_band="low",
            requires_reviewer_confirmation=True,
            consistency_note="no_reference_rows_found_for_cross_check",
        )

    # If no row is flagged is_primary (a real data gap for sparsely-seeded or
    # externally-added SKUs), fall back to the WORST similarity as the
    # representative score -- never default to a pass just because the flag
    # is missing.
    effective_primary = primary_similarity if primary_similarity is not None else min(reference_similarities)
    spread = max(reference_similarities) - min(reference_similarities)
    primary_ok = effective_primary >= SKU_CONSISTENCY_PRIMARY_MIN
    spread_ok = len(reference_similarities) < 2 or spread <= SKU_CONSISTENCY_SPREAD_MAX

    if primary_ok and spread_ok:
        return replace(decision, consistency_note="consistent_across_references")

    if not primary_ok:
        reason = f"primary_similarity={effective_primary:.4f} < {SKU_CONSISTENCY_PRIMARY_MIN}"
    else:
        reason = f"reference_spread={spread:.4f} > {SKU_CONSISTENCY_SPREAD_MAX} (inconsistent across reference images)"

    return replace(
        decision,
        confidence_band="low",
        requires_reviewer_confirmation=True,
        consistency_note=reason,
    )


def _brand_key(value: object) -> str:
    """Normalise a brand so 'Lock&Lock', 'LOCK & LOCK' and 'LocknLock' compare equal."""
    if not isinstance(value, str):
        return ""
    lowered = value.casefold().replace("&", "n").replace(" and ", "n")
    return re.sub(r"[^0-9a-zà-ỹ]+", "", lowered)


def apply_brand_conflict_gate(
    decision: SkuDecision,
    vision_brand: object,
    vision_brand_confidence: object,
    catalog_brand: object,
    *,
    min_confidence: float = 0.5,
) -> SkuDecision:
    """Drop a SKU proposal whose catalog brand contradicts the brand read from the image.

    Embedding similarity alone can pair a competitor's look-alike product with
    a catalog SKU. When Vision reads a different manufacturer brand on the item,
    that is positive evidence against the proposal, so the SKU is withheld
    (``sku=None``, band ``unmatched``) and the conflict is recorded for the
    reviewer. Unknown/blank brands on either side never trigger the gate.
    """
    if not decision.sku:
        return decision
    vision_key = _brand_key(vision_brand)
    catalog_key = _brand_key(catalog_brand)
    if not vision_key or not catalog_key or vision_key == "unknown" or catalog_key == "unknown":
        return decision
    if isinstance(vision_brand_confidence, (int, float)) and float(vision_brand_confidence) < min_confidence:
        return decision
    if vision_key == catalog_key or vision_key in catalog_key or catalog_key in vision_key:
        return decision
    return replace(
        decision,
        sku=None,
        confidence_band="unmatched",
        requires_reviewer_confirmation=True,
        consistency_note=f"brand_conflict: image brand '{str(vision_brand).strip()[:60]}' != catalog brand '{str(catalog_brand).strip()[:60]}'",
    )


def _extract_json(value: str) -> Any:
    value = value.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", value, flags=re.DOTALL | re.IGNORECASE)
    return json.loads(fenced.group(1) if fenced else value)


def sanitize_vision_metadata(value: Any) -> dict[str, Any]:
    """Parse only open metadata from a vision response.

    ``sku`` and any unknown keys are ignored even when the provider returns
    them. This is a defense-in-depth guard in addition to the prompt.
    """
    if isinstance(value, str):
        try:
            value = _extract_json(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
    if not isinstance(value, dict):
        return {}

    output: dict[str, Any] = {}
    for key, limit in _METADATA_TEXT_LIMITS.items():
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            output[key] = raw.strip()[:limit]
    if isinstance(value.get("has_people"), bool):
        output["has_people"] = value["has_people"]
    if "shot_type" in value:
        raw_shot = value.get("shot_type")
        if isinstance(raw_shot, str) and raw_shot.strip().lower() in _ALLOWED_SHOT_TYPES:
            output["shot_type"] = raw_shot.strip().lower()
        else:
            output["shot_type"] = None
    for key in _METADATA_CONFIDENCE_KEYS:
        raw = value.get(key)
        if isinstance(raw, (float, int)):
            output[key] = min(1.0, max(0.0, float(raw)))
    raw_visible_text = value.get("visible_text")
    if isinstance(raw_visible_text, list):
        visible_text: list[str] = []
        seen_text: set[str] = set()
        for item in raw_visible_text[:8]:
            if isinstance(item, str) and item.strip():
                text = " ".join(item.split())[:120]
                if text.casefold() not in seen_text:
                    seen_text.add(text.casefold())
                    visible_text.append(text)
        if visible_text:
            output["visible_text"] = visible_text
    raw_keywords = value.get("keywords")
    if isinstance(raw_keywords, list):
        keywords: list[str] = []
        seen_kw: set[str] = set()
        for item in raw_keywords[:8]:
            if isinstance(item, str) and item.strip():
                kw = " ".join(item.split())[:60].lower()
                if kw not in seen_kw:
                    seen_kw.add(kw)
                    keywords.append(kw)
        if keywords:
            output["keywords"] = keywords
    return output
