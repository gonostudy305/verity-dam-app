from __future__ import annotations

import unittest

from search_intelligence.latency_bench import (
    LATENCY_REPORT_LABEL,
    measure_latency_distribution,
    percentile,
)
from search_intelligence.search_document import SearchDocument

_FIXTURE_DOCUMENTS = tuple(
    SearchDocument(asset_id=f"doc-{i}", title=f"Khóa thông minh Verity mẫu {i}", sku=f"SKU-{i}", brand="Verity")
    for i in range(20)
)

_FIXTURE_QUERIES = (
    "khóa thông minh",
    "khoa thong minh",
    "HR-21",
    "aqraa",
    "robot hut bui",
    "camera ngoài trời",
    "khóa cửa chính",
    "dreem",
)


class PercentileHelperTest(unittest.TestCase):
    def test_percentile_of_empty_sequence_is_zero(self) -> None:
        self.assertEqual(percentile([], 50), 0.0)

    def test_p50_of_uniform_sequence(self) -> None:
        self.assertAlmostEqual(percentile([1, 2, 3, 4, 5], 50), 3.0)

    def test_percentiles_are_monotonic(self) -> None:
        values = [1, 5, 2, 9, 3, 7, 4]
        self.assertLessEqual(percentile(values, 50), percentile(values, 95))
        self.assertLessEqual(percentile(values, 95), percentile(values, 99))


class LatencyMeasurementTest(unittest.TestCase):
    """This is offline, measured latency on whatever machine runs this
    test -- explicitly NOT a production SLO."""

    def test_report_is_labeled_non_production(self) -> None:
        report = measure_latency_distribution(_FIXTURE_QUERIES, _FIXTURE_DOCUMENTS)
        self.assertEqual(report.label, LATENCY_REPORT_LABEL)

    def test_percentiles_are_monotonic_and_nonnegative(self) -> None:
        report = measure_latency_distribution(_FIXTURE_QUERIES, _FIXTURE_DOCUMENTS)
        self.assertGreaterEqual(report.p50_ms, 0.0)
        self.assertLessEqual(report.p50_ms, report.p95_ms)
        self.assertLessEqual(report.p95_ms, report.p99_ms)

    def test_sample_count_matches_query_count(self) -> None:
        report = measure_latency_distribution(_FIXTURE_QUERIES, _FIXTURE_DOCUMENTS)
        self.assertEqual(report.sample_count, len(_FIXTURE_QUERIES))

    def test_per_stage_breakdown_covers_every_stage(self) -> None:
        report = measure_latency_distribution(_FIXTURE_QUERIES, _FIXTURE_DOCUMENTS)
        for stage in (
            "normalize_ms",
            "entity_extraction_ms",
            "typo_generation_ms",
            "lexical_scoring_ms",
            "rrf_ms",
            "reranking_ms",
        ):
            self.assertIn(stage, report.per_stage_p50_ms)
            self.assertGreaterEqual(report.per_stage_p50_ms[stage], 0.0)


if __name__ == "__main__":
    unittest.main()
