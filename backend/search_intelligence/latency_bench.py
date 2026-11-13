"""Offline, non-production latency measurement.

This module measures how long this checkpoint's OWN offline pipeline
stages take on a deterministic local fixture -- it invents no production
SLO. Every report is labeled ``MEASURED_NON_PRODUCTION_LATENCY`` and must
be read as exactly that: a local measurement on whatever machine ran the
test, useful for spotting an obviously pathological stage, not a
service-level commitment.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Sequence

from .entity_extractor import extract_entities
from .exact_channel import compute_exact_signals, rank_tier
from .fuzzy_channel import generate_fuzzy_query_variants
from .lexical_scorer import score_document
from .reranker import RerankCandidate, rerank
from .rrf_fusion import RankedChannelHit, reciprocal_rank_fusion
from .search_document import SearchDocument
from .vietnamese_normalizer import normalize_query

LATENCY_REPORT_LABEL = "MEASURED_NON_PRODUCTION_LATENCY"


@dataclass(frozen=True)
class StageLatenciesMs:
    normalize_ms: float
    entity_extraction_ms: float
    typo_generation_ms: float
    lexical_scoring_ms: float
    rrf_ms: float
    reranking_ms: float
    total_ms: float


def measure_query_latency_ms(raw_query: str, documents: Sequence[SearchDocument]) -> StageLatenciesMs:
    """One end-to-end pass through this checkpoint's own offline pipeline,
    timing each stage. Pure/offline: no DB, no network, no real model."""

    start = time.perf_counter()

    t0 = time.perf_counter()
    normalized = normalize_query(raw_query)
    t1 = time.perf_counter()

    entities = extract_entities(normalized)
    t2 = time.perf_counter()

    fuzzy = generate_fuzzy_query_variants(normalized)
    t3 = time.perf_counter()

    lexical_scores = {document.asset_id: score_document(document, normalized) for document in documents}
    lexical_ranked = sorted(
        (RankedChannelHit(asset_id=asset_id, rank=0) for asset_id in lexical_scores),
        key=lambda hit: (-lexical_scores[hit.asset_id].total, hit.asset_id),
    )
    lexical_ranked = tuple(
        RankedChannelHit(asset_id=hit.asset_id, rank=index + 1) for index, hit in enumerate(lexical_ranked)
    )
    t4 = time.perf_counter()

    rrf_results = reciprocal_rank_fusion(lexical_ranked, ())
    rrf_score_by_id = {result.asset_id: result.rrf_score for result in rrf_results}
    t5 = time.perf_counter()

    candidates = [
        RerankCandidate(
            asset_id=document.asset_id,
            rank_tier=rank_tier(compute_exact_signals(document, normalized, entities)),
            exact_signals=compute_exact_signals(document, normalized, entities),
            lexical_score=lexical_scores[document.asset_id].total,
            rrf_score=rrf_score_by_id.get(document.asset_id, 0.0),
        )
        for document in documents
    ]
    rerank(candidates)
    t6 = time.perf_counter()

    end = time.perf_counter()
    return StageLatenciesMs(
        normalize_ms=(t1 - t0) * 1000,
        entity_extraction_ms=(t2 - t1) * 1000,
        typo_generation_ms=(t3 - t2) * 1000,
        lexical_scoring_ms=(t4 - t3) * 1000,
        rrf_ms=(t5 - t4) * 1000,
        reranking_ms=(t6 - t5) * 1000,
        total_ms=(end - start) * 1000,
    )


def percentile(values: Sequence[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = (len(ordered) - 1) * (p / 100.0)
    lower = math.floor(k)
    upper = math.ceil(k)
    if lower == upper:
        return ordered[int(k)]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (k - lower)


@dataclass(frozen=True)
class LatencyReport:
    label: str = field(default=LATENCY_REPORT_LABEL)
    p50_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    sample_count: int = 0
    per_stage_p50_ms: dict[str, float] = field(default_factory=dict)


def measure_latency_distribution(
    queries: Sequence[str], documents: Sequence[SearchDocument]
) -> LatencyReport:
    """Run every query in ``queries`` once against ``documents`` and report
    p50/p95/p99 of the total pipeline time, plus a per-stage p50
    breakdown. Explicitly labeled ``MEASURED_NON_PRODUCTION_LATENCY`` --
    never a production SLO."""

    samples = [measure_query_latency_ms(query, documents) for query in queries]
    totals = [sample.total_ms for sample in samples]
    stage_names = (
        "normalize_ms",
        "entity_extraction_ms",
        "typo_generation_ms",
        "lexical_scoring_ms",
        "rrf_ms",
        "reranking_ms",
    )
    per_stage_p50 = {
        name: percentile([getattr(sample, name) for sample in samples], 50) for name in stage_names
    }
    return LatencyReport(
        p50_ms=percentile(totals, 50),
        p95_ms=percentile(totals, 95),
        p99_ms=percentile(totals, 99),
        sample_count=len(samples),
        per_stage_p50_ms=per_stage_p50,
    )
