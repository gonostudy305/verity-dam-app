"""Cross-language SearchPlan contract test (Python side).

Asserts that the frozen Python authority -- ``normalize_query`` ->
``extract_entities`` -> ``RuleBasedQueryClassifier`` -- reproduces the ``shared``
block (intent / confidence / tokens / entities) of every case in the golden
fixture ``backend/tests/fixtures/search_plan_golden.json``.

The SAME fixture is asserted by the TypeScript mirror
(``src/lib/server/search-intelligence-plan.test.ts``), which additionally asserts
the ``ts_only`` serving-layer block. Keeping both languages pinned to one file is
what makes the query-understanding contract cross-language by construction: if the
authority drifts, this test goes red and the fixture must be regenerated from it.

This is a pure in-memory contract test: no DB, no network, no embedding calls.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from search_intelligence.entity_extractor import extract_entities
from search_intelligence.query_classifier import RuleBasedQueryClassifier
from search_intelligence.vietnamese_normalizer import normalize_query

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "search_plan_golden.json"


def _entities_block(entities) -> dict:
    """Project the authority's extraction result into the fixture's `shared.entities`
    shape. Each list is sorted so the comparison is order-independent -- exactly how
    the fixture was generated from this same authority."""
    return {
        "skus": sorted(m.record.sku for m in entities.skus),
        "brands": sorted(m.value for m in entities.brands),
        "categories": sorted(m.value for m in entities.categories),
        "spaces": sorted(m.value for m in entities.spaces),
        "installationContexts": sorted(m.value for m in entities.installation_contexts),
        "features": sorted(m.value for m in entities.features),
        "protocols": sorted(m.value for m in entities.protocols),
    }


class SearchPlanSharedContractTest(unittest.TestCase):
    """Every golden `shared` block must be reproduced exactly by the authority."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.classifier = RuleBasedQueryClassifier()

    def test_fixture_is_present_and_versioned(self) -> None:
        self.assertEqual(self.fixture["version"], 1)
        self.assertGreaterEqual(len(self.fixture["families"]), 17)

    def test_shared_contract_matches_authority(self) -> None:
        for family in self.fixture["families"]:
            for case in family["cases"]:
                query = case["query"]
                shared = case["shared"]
                with self.subTest(family=family["id"], query=query):
                    normalized = normalize_query(query)
                    entities = extract_entities(normalized)
                    classification = self.classifier.classify(normalized, entities)

                    self.assertEqual(
                        classification.query_type.value,
                        shared["intent"],
                        msg=f"intent mismatch for {query!r}",
                    )
                    self.assertAlmostEqual(
                        round(classification.confidence, 3),
                        shared["confidence"],
                        places=3,
                        msg=f"confidence mismatch for {query!r}",
                    )
                    self.assertEqual(
                        list(normalized.tokens),
                        shared["tokens"],
                        msg=f"tokens mismatch for {query!r}",
                    )
                    self.assertEqual(
                        _entities_block(entities),
                        shared["entities"],
                        msg=f"entities mismatch for {query!r}",
                    )

    def test_every_case_has_the_required_shared_keys(self) -> None:
        required = set(self.fixture["shared_fields"])
        for family in self.fixture["families"]:
            for case in family["cases"]:
                with self.subTest(family=family["id"], query=case["query"]):
                    self.assertTrue(
                        required.issubset(case["shared"].keys()),
                        msg=f"missing shared keys for {case['query']!r}",
                    )


if __name__ == "__main__":
    unittest.main()
