"""Offline search-evaluation schema and metric runner.

This module defines the SCHEMA and the pure metric computations only. It
never fabricates relevance labels and never uses the current/legacy ILIKE
search ranking as a proxy for human ground truth -- both are explicitly
out of scope for this checkpoint (see the package docstring). Suite C 0-3
human relevance grades do not exist yet; they are a hard prerequisite for
running this evaluator against real data. Every function here is a pure
function over caller-supplied judgments/rankings so it is fully
unit-testable with small synthetic fixtures without needing any real
human-labeled corpus.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping, Sequence


class QueryBucket(str, Enum):
    ACCENTED_VN = "ACCENTED_VN"
    UNACCENTED_VN = "UNACCENTED_VN"
    SKU = "SKU"
    BRAND_MODEL = "BRAND_MODEL"
    TYPO = "TYPO"
    MIXED_VI_EN = "MIXED_VI_EN"
    NATURAL_LANGUAGE = "NATURAL_LANGUAGE"
    SCENE_QUERY = "SCENE_QUERY"
    ZERO_RESULT = "ZERO_RESULT"
    SHORT_QUERY = "SHORT_QUERY"  # <= 2 tokens
    LONG_QUERY = "LONG_QUERY"


@dataclass(frozen=True)
class RelevanceJudgment:
    """One human 0-3 relevance grade for (query_id, doc_id).

    Grade scale (0-3), matching the repo's existing Suite C human-hardness
    grading convention referenced elsewhere in this codebase's P2/P3
    benchmark docs: 0 = not relevant, 1 = marginally relevant, 2 =
    relevant, 3 = exact/ideal match. THIS SCHEMA HOLDS NO REAL DATA -- no
    judgments are fabricated anywhere in this checkpoint.
    """

    query_id: str
    doc_id: str
    grade: int  # 0-3

    def __post_init__(self) -> None:
        if not 0 <= self.grade <= 3:
            raise ValueError(f"relevance grade must be 0-3, got {self.grade!r}")


@dataclass(frozen=True)
class RankedResult:
    """The ranked list of doc ids one search implementation returned for one query."""

    query_id: str
    doc_ids: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class PairedQuery:
    """Same underlying intent, expressed once accented and once unaccented."""

    accented_query_id: str
    unaccented_query_id: str


@dataclass(frozen=True)
class QueryMetrics:
    query_id: str
    bucket: QueryBucket | None
    ndcg_5: float
    ndcg_10: float
    mrr_10: float
    recall_5: float
    recall_10: float
    hit_rate_5: float
    hit_rate_10: float


@dataclass(frozen=True)
class EvaluationReport:
    per_query: tuple[QueryMetrics, ...]
    overall: dict[str, float]
    bucket_breakdown: dict[str, dict[str, float]]
    exact_sku_top1_accuracy: float | None
    zero_result_rate: float
    accented_hr_5: float | None
    unaccented_hr_5: float | None
    paired_accent_unaccent_delta: float | None
    query_count: int
    judgment_count: int


def _grades_for(query_id: str, doc_ids: Sequence[str], judgments: Mapping[tuple[str, str], int]) -> list[int]:
    return [judgments.get((query_id, doc_id), 0) for doc_id in doc_ids]


def _dedupe_doc_ids(doc_ids: Sequence[str]) -> tuple[str, ...]:
    """Drop repeat doc ids from one ranked list, keeping first occurrence.

    A duplicate retrieval of the same document (whether from a buggy
    ranker or from fusing multiple channels without deduping) must not be
    double-counted by any metric below -- this is the single choke point
    :func:`evaluate` reads every ranked list through.
    """

    seen: set[str] = set()
    deduped: list[str] = []
    for doc_id in doc_ids:
        if doc_id in seen:
            continue
        seen.add(doc_id)
        deduped.append(doc_id)
    return tuple(deduped)


def dcg_at_k(grades: Sequence[int], k: int) -> float:
    return sum(grade / math.log2(index + 2) for index, grade in enumerate(grades[:k]))


def ndcg_at_k(grades: Sequence[int], k: int, ideal_grades: Sequence[int] | None = None) -> float:
    """NDCG@k.

    ``ideal_grades`` should be every human-judged grade that exists for
    this query -- not just the grades of the docs actually retrieved -- so
    IDCG reflects the best achievable DCG given the full judgment set. A
    ranking that fails to retrieve a highly-relevant (e.g. grade-3)
    document is then correctly penalized versus a perfect NDCG of 1.0, even
    though the retrieved list's own grades might otherwise look "ideal" in
    isolation. When ``ideal_grades`` is omitted, this falls back to
    re-sorting ``grades`` itself, matching the simpler single-list
    behaviour standalone unit tests exercise.
    """

    dcg = dcg_at_k(grades, k)
    ideal_source = grades if ideal_grades is None else ideal_grades
    ideal = sorted(ideal_source, reverse=True)
    idcg = dcg_at_k(ideal, k)
    return 0.0 if idcg == 0 else dcg / idcg


def mrr_at_k(grades: Sequence[int], k: int) -> float:
    for index, grade in enumerate(grades[:k]):
        if grade > 0:
            return 1.0 / (index + 1)
    return 0.0


def recall_at_k(grades: Sequence[int], total_relevant: int, k: int) -> float:
    if total_relevant <= 0:
        return 0.0
    retrieved_relevant = sum(1 for grade in grades[:k] if grade > 0)
    return retrieved_relevant / total_relevant


def hit_rate_at_k(grades: Sequence[int], k: int) -> float:
    return 1.0 if any(grade > 0 for grade in grades[:k]) else 0.0


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def evaluate(
    ranked_results: Sequence[RankedResult],
    judgments: Mapping[tuple[str, str], int],
    *,
    query_buckets: Mapping[str, QueryBucket] | None = None,
    expected_sku_by_query: Mapping[str, str] | None = None,
    result_sku_by_doc: Mapping[str, str] | None = None,
    paired_queries: Sequence[PairedQuery] = (),
) -> EvaluationReport:
    """Compute the full metric set over caller-supplied rankings/judgments.

    Every argument is caller-supplied data -- this function fabricates
    nothing. Calling it with empty ``ranked_results``/``judgments`` (the
    only state possible before Suite C human grades exist) yields a valid,
    all-zero/``None`` schema-shaped report rather than raising, so the
    runner skeleton is exercisable today without any real labels.
    """

    buckets = query_buckets or {}
    per_query: list[QueryMetrics] = []
    for result in ranked_results:
        deduped_doc_ids = _dedupe_doc_ids(result.doc_ids)
        total_relevant = sum(1 for (q, _), grade in judgments.items() if q == result.query_id and grade > 0)
        grades = _grades_for(result.query_id, deduped_doc_ids, judgments)
        ideal_grades = [grade for (q, _), grade in judgments.items() if q == result.query_id]
        per_query.append(
            QueryMetrics(
                query_id=result.query_id,
                bucket=buckets.get(result.query_id),
                ndcg_5=ndcg_at_k(grades, 5, ideal_grades=ideal_grades),
                ndcg_10=ndcg_at_k(grades, 10, ideal_grades=ideal_grades),
                mrr_10=mrr_at_k(grades, 10),
                recall_5=recall_at_k(grades, total_relevant, 5),
                recall_10=recall_at_k(grades, total_relevant, 10),
                hit_rate_5=hit_rate_at_k(grades, 5),
                hit_rate_10=hit_rate_at_k(grades, 10),
            )
        )

    overall = {
        "ndcg_5": _mean([m.ndcg_5 for m in per_query]),
        "ndcg_10": _mean([m.ndcg_10 for m in per_query]),
        "mrr_10": _mean([m.mrr_10 for m in per_query]),
        "recall_5": _mean([m.recall_5 for m in per_query]),
        "recall_10": _mean([m.recall_10 for m in per_query]),
        "hit_rate_5": _mean([m.hit_rate_5 for m in per_query]),
        "hit_rate_10": _mean([m.hit_rate_10 for m in per_query]),
    }

    bucket_breakdown: dict[str, dict[str, float]] = {}
    for bucket in QueryBucket:
        bucket_metrics = [m for m in per_query if m.bucket == bucket]
        if not bucket_metrics:
            continue
        bucket_breakdown[bucket.value] = {
            "ndcg_5": _mean([m.ndcg_5 for m in bucket_metrics]),
            "ndcg_10": _mean([m.ndcg_10 for m in bucket_metrics]),
            "mrr_10": _mean([m.mrr_10 for m in bucket_metrics]),
            "recall_5": _mean([m.recall_5 for m in bucket_metrics]),
            "recall_10": _mean([m.recall_10 for m in bucket_metrics]),
            "hit_rate_5": _mean([m.hit_rate_5 for m in bucket_metrics]),
            "hit_rate_10": _mean([m.hit_rate_10 for m in bucket_metrics]),
            "query_count": float(len(bucket_metrics)),
        }

    zero_result_rate = _mean([1.0 if not r.doc_ids else 0.0 for r in ranked_results])

    exact_sku_top1_accuracy: float | None = None
    if expected_sku_by_query and result_sku_by_doc:
        hits: list[float] = []
        for result in ranked_results:
            expected = expected_sku_by_query.get(result.query_id)
            if expected is None:
                continue
            top1_sku = result_sku_by_doc.get(result.doc_ids[0]) if result.doc_ids else None
            hits.append(1.0 if top1_sku == expected else 0.0)
        exact_sku_top1_accuracy = _mean(hits) if hits else None

    accented_values = [m.hit_rate_5 for m in per_query if m.bucket == QueryBucket.ACCENTED_VN]
    unaccented_values = [m.hit_rate_5 for m in per_query if m.bucket == QueryBucket.UNACCENTED_VN]
    accented_hr_5 = _mean(accented_values) if accented_values else None
    unaccented_hr_5 = _mean(unaccented_values) if unaccented_values else None

    paired_accent_unaccent_delta: float | None = None
    if paired_queries:
        metrics_by_query = {m.query_id: m for m in per_query}
        deltas: list[float] = []
        for pair in paired_queries:
            accented_metric = metrics_by_query.get(pair.accented_query_id)
            unaccented_metric = metrics_by_query.get(pair.unaccented_query_id)
            if accented_metric is None or unaccented_metric is None:
                continue
            deltas.append(accented_metric.hit_rate_5 - unaccented_metric.hit_rate_5)
        paired_accent_unaccent_delta = _mean(deltas) if deltas else None

    return EvaluationReport(
        per_query=tuple(per_query),
        overall=overall,
        bucket_breakdown=bucket_breakdown,
        exact_sku_top1_accuracy=exact_sku_top1_accuracy,
        zero_result_rate=zero_result_rate,
        accented_hr_5=accented_hr_5,
        unaccented_hr_5=unaccented_hr_5,
        paired_accent_unaccent_delta=paired_accent_unaccent_delta,
        query_count=len(ranked_results),
        judgment_count=len(judgments),
    )


def classify_query_bucket(*, token_count: int, is_sku_query: bool, is_typo: bool, has_accents: bool) -> QueryBucket:
    """A minimal, deterministic helper for assigning the length-based/
    accent-based buckets that don't require entity/classifier context.
    Callers with richer context (mixed-language, scene, brand/model, SKU)
    should assign :class:`QueryBucket` directly from
    :mod:`search_intelligence.query_classifier` output instead of this
    helper, which only covers the length/accent buckets unambiguously
    derivable from the raw query alone.
    """

    if is_sku_query:
        return QueryBucket.SKU
    if is_typo:
        return QueryBucket.TYPO
    if token_count <= 2:
        return QueryBucket.SHORT_QUERY
    if token_count >= 6:
        return QueryBucket.LONG_QUERY
    return QueryBucket.ACCENTED_VN if has_accents else QueryBucket.UNACCENTED_VN
