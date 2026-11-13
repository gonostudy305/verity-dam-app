from __future__ import annotations

import unittest

from search_intelligence.vocabulary import BRAND_VOCABULARY, load_brand_vocabulary


class _FakeTaxonomyRepo:
    def __init__(self) -> None:
        self.query = ""

    def fetch_all(self, query: str):
        self.query = query
        return [{"value": "Acme"}, {"value": "Drift"}]


class SearchVocabularyTests(unittest.TestCase):
    def test_brand_loader_reads_native_public_taxonomy_options(self) -> None:
        repo = _FakeTaxonomyRepo()

        self.assertEqual(load_brand_vocabulary(repo), ("Acme", "Drift"))
        self.assertIn("public.verity_taxonomy_options", repo.query)
        self.assertIn("facet = 'brand'", repo.query)
        self.assertIn("is_active = true", repo.query)

    def test_brand_loader_falls_back_when_repository_is_unavailable(self) -> None:
        self.assertEqual(load_brand_vocabulary(None), BRAND_VOCABULARY)


if __name__ == "__main__":
    unittest.main()
