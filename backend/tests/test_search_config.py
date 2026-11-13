"""Unit tests for backend search_config module."""

import unittest
from search_intelligence.search_config import (
    DEFAULT_SEARCH_CONFIG,
    clear_search_config_cache,
    load_search_config,
)


class TestSearchConfig(unittest.TestCase):
    def test_default_config_values(self):
        self.assertEqual(DEFAULT_SEARCH_CONFIG["rrf_k"], 60)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["semantic_weight"], 1.0)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["lexical_weight"], 1.0)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["mmr_lambda"], 0.7)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["mmr_pool_size"], 40)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["mmr_output_size"], 20)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["rerank_lexical"], 1.0)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["rerank_fuzzy"], 0.5)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["rerank_rrf"], 10.0)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["rerank_entity"], 1.0)
        self.assertEqual(DEFAULT_SEARCH_CONFIG["semantic_enabled"], True)

    def test_load_search_config_fallback(self):
        clear_search_config_cache()
        cfg = load_search_config(None)
        self.assertEqual(cfg["semantic_enabled"], True)
        self.assertEqual(cfg["rrf_k"], 60)


if __name__ == "__main__":
    unittest.main()
