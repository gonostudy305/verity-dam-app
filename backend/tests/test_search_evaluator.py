from __future__ import annotations

import unittest

from search_intelligence.evaluator import (
    PairedQuery,
    QueryBucket,
    RankedResult,
    RelevanceJudgment,
    classify_query_bucket,
    dcg_at_k,
    evaluate,
    hit_rate_at_k,
    mrr_at_k,
    ndcg_at_k,
    recall_at_k,
)


class MetricUnitTest(unittest.TestCase):
    def test_dcg_perfect_ordering(self) -> None:
        self.assertGreater(dcg_at_k([3, 2, 1], 3), dcg_at_k([1, 2, 3], 3))

    def test_ndcg_of_ideal_order_is_one(self) -> None:
        self.assertAlmostEqual(ndcg_at_k([3, 2, 1], 3), 1.0)

    def test_ndcg_of_all_zero_grades_is_zero(self) -> None:
        self.assertEqual(ndcg_at_k([0, 0, 0], 3), 0.0)

    def test_mrr_finds_first_relevant_rank(self) -> None:
        self.assertAlmostEqual(mrr_at_k([0, 0, 1, 0], 10), 1.0 / 3.0)

    def test_mrr_zero_when_nothing_relevant(self) -> None:
        self.assertEqual(mrr_at_k([0, 0, 0], 10), 0.0)

    def test_recall_at_k(self) -> None:
        self.assertAlmostEqual(recall_at_k([1, 0, 1, 0], total_relevant=4, k=4), 0.5)

    def test_recall_zero_relevant_is_zero_not_error(self) -> None:
        self.assertEqual(recall_at_k([0, 0], total_relevant=0, k=2), 0.0)

    def test_hit_rate_true_when_any_relevant(self) -> None:
        self.assertEqual(hit_rate_at_k([0, 0, 2], 3), 1.0)

    def test_hit_rate_false_when_none_relevant(self) -> None:
        self.assertEqual(hit_rate_at_k([0, 0, 0], 3), 0.0)


class RelevanceJudgmentSchemaTest(unittest.TestCase):
    def test_grade_out_of_range_rejected(self) -> None:
        with self.assertRaises(ValueError):
            RelevanceJudgment(query_id="q1", doc_id="d1", grade=4)

    def test_valid_grades_accepted(self) -> None:
        for grade in range(4):
            RelevanceJudgment(query_id="q1", doc_id="d1", grade=grade)


class EvaluateRunnerTest(unittest.TestCase):
    def test_empty_input_yields_schema_shaped_zero_report_no_fabrication(self) -> None:
        report = evaluate(ranked_results=(), judgments={})
        self.assertEqual(report.query_count, 0)
        self.assertEqual(report.judgment_count, 0)
        self.assertEqual(report.overall["ndcg_5"], 0.0)
        self.assertEqual(report.bucket_breakdown, {})

    def test_full_synthetic_report_with_bucket_breakdown(self) -> None:
        judgments = {
            ("q1", "d1"): 3,
            ("q1", "d2"): 0,
            ("q2", "d3"): 2,
        }
        ranked_results = (
            RankedResult(query_id="q1", doc_ids=("d1", "d2")),
            RankedResult(query_id="q2", doc_ids=("d3",)),
            RankedResult(query_id="q3", doc_ids=()),
        )
        buckets = {"q1": QueryBucket.SKU, "q2": QueryBucket.ACCENTED_VN, "q3": QueryBucket.ZERO_RESULT}
        report = evaluate(ranked_results=ranked_results, judgments=judgments, query_buckets=buckets)

        self.assertEqual(report.query_count, 3)
        self.assertAlmostEqual(report.zero_result_rate, 1.0 / 3.0)
        self.assertIn(QueryBucket.SKU.value, report.bucket_breakdown)
        self.assertIn(QueryBucket.ACCENTED_VN.value, report.bucket_breakdown)
        self.assertEqual(report.bucket_breakdown[QueryBucket.SKU.value]["query_count"], 1.0)

    def test_exact_sku_top1_accuracy_schema(self) -> None:
        ranked_results = (RankedResult(query_id="q1", doc_ids=("d1",)),)
        report = evaluate(
            ranked_results=ranked_results,
            judgments={},
            expected_sku_by_query={"q1": "HR-21"},
            result_sku_by_doc={"d1": "HR-21"},
        )
        self.assertEqual(report.exact_sku_top1_accuracy, 1.0)

    def test_paired_accent_unaccent_delta_schema(self) -> None:
        judgments = {("q_accented", "d1"): 2, ("q_unaccented", "d1"): 0}
        ranked_results = (
            RankedResult(query_id="q_accented", doc_ids=("d1",)),
            RankedResult(query_id="q_unaccented", doc_ids=("d1",)),
        )
        buckets = {"q_accented": QueryBucket.ACCENTED_VN, "q_unaccented": QueryBucket.UNACCENTED_VN}
        report = evaluate(
            ranked_results=ranked_results,
            judgments=judgments,
            query_buckets=buckets,
            paired_queries=(PairedQuery(accented_query_id="q_accented", unaccented_query_id="q_unaccented"),),
        )
        self.assertEqual(report.accented_hr_5, 1.0)
        self.assertEqual(report.unaccented_hr_5, 0.0)
        self.assertEqual(report.paired_accent_unaccent_delta, 1.0)


class GlobalIdcgRegressionTest(unittest.TestCase):
    """Part 0A fix: IDCG must reflect the FULL judgment set for a query, not
    just the grades of whatever got retrieved -- otherwise missing a
    grade-3 document is invisible to NDCG."""

    def test_missing_best_doc_lowers_ndcg_below_one(self) -> None:
        judgments = {("q1", "d_best"): 3, ("q1", "d_mid"): 2}
        ranked_results = (RankedResult(query_id="q1", doc_ids=("d_mid",)),)
        report = evaluate(ranked_results=ranked_results, judgments=judgments)
        self.assertEqual(len(report.per_query), 1)
        self.assertLess(report.per_query[0].ndcg_5, 1.0)
        self.assertLess(report.per_query[0].ndcg_10, 1.0)

    def test_retrieving_only_the_best_doc_still_scores_one(self) -> None:
        # Sanity check: when the retrieved list literally IS the ideal
        # ordering of the full judgment set, NDCG is still exactly 1.0.
        judgments = {("q1", "d_best"): 3, ("q1", "d_mid"): 2}
        ranked_results = (RankedResult(query_id="q1", doc_ids=("d_best", "d_mid")),)
        report = evaluate(ranked_results=ranked_results, judgments=judgments)
        self.assertAlmostEqual(report.per_query[0].ndcg_5, 1.0)

    def test_ndcg_at_k_standalone_still_supports_the_old_single_list_call(self) -> None:
        # Backwards-compatible behaviour for callers that don't have a
        # separate "full judgment set" available.
        self.assertAlmostEqual(ndcg_at_k([3, 2, 1], 3), 1.0)
        self.assertEqual(ndcg_at_k([0, 0, 0], 3), 0.0)


class DuplicateDocIdRegressionTest(unittest.TestCase):
    """Part 0A fix: a duplicate retrieval of the same relevant doc must not
    be double-counted by recall/NDCG/etc."""

    def test_duplicate_relevant_doc_does_not_inflate_recall_past_one(self) -> None:
        judgments = {("q1", "d1"): 2}
        ranked_results = (RankedResult(query_id="q1", doc_ids=("d1", "d1", "d1")),)
        report = evaluate(ranked_results=ranked_results, judgments=judgments)
        self.assertLessEqual(report.per_query[0].recall_5, 1.0)
        self.assertAlmostEqual(report.per_query[0].recall_5, 1.0)

    def test_duplicate_doc_ids_deduped_helper(self) -> None:
        from search_intelligence.evaluator import _dedupe_doc_ids

        self.assertEqual(_dedupe_doc_ids(("d1", "d2", "d1", "d3", "d2")), ("d1", "d2", "d3"))


class QueryBucketHelperTest(unittest.TestCase):
    def test_sku_bucket_takes_precedence(self) -> None:
        bucket = classify_query_bucket(token_count=1, is_sku_query=True, is_typo=True, has_accents=False)
        self.assertEqual(bucket, QueryBucket.SKU)

    def test_short_query_bucket(self) -> None:
        bucket = classify_query_bucket(token_count=2, is_sku_query=False, is_typo=False, has_accents=True)
        self.assertEqual(bucket, QueryBucket.SHORT_QUERY)

    def test_long_query_bucket(self) -> None:
        bucket = classify_query_bucket(token_count=7, is_sku_query=False, is_typo=False, has_accents=True)
        self.assertEqual(bucket, QueryBucket.LONG_QUERY)

    def test_accented_vs_unaccented_bucket(self) -> None:
        self.assertEqual(
            classify_query_bucket(token_count=3, is_sku_query=False, is_typo=False, has_accents=True),
            QueryBucket.ACCENTED_VN,
        )
        self.assertEqual(
            classify_query_bucket(token_count=3, is_sku_query=False, is_typo=False, has_accents=False),
            QueryBucket.UNACCENTED_VN,
        )


if __name__ == "__main__":
    unittest.main()
