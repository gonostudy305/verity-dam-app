"""Unit tests for SKU alias resolution and catalog product lookup."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from app.native_gateway import NativeGateway
from app.sku_alias_resolver import resolve_sku_aliases, resolve_sku_group_for_matching


class TestSkuAliasResolver(unittest.TestCase):
    def test_resolve_sku_aliases_returns_primary_and_aliases(self):
        mock_gateway = MagicMock()
        mock_gateway._fetch_all.return_value = [
            {"primary_sku": "AC-S02", "aliases": ["Acme A100", "A100"]}
        ]

        result = resolve_sku_aliases(mock_gateway, "Acme A100")
        self.assertIn("Acme A100", result)
        self.assertIn("AC-S02", result)
        self.assertIn("A100", result)

    def test_resolve_sku_aliases_handles_empty_input(self):
        mock_gateway = MagicMock()
        result = resolve_sku_aliases(mock_gateway, "")
        self.assertEqual(result, [])

    def test_resolve_sku_aliases_handles_db_exception(self):
        mock_gateway = MagicMock()
        mock_gateway._fetch_all.side_effect = Exception("DB timeout")
        result = resolve_sku_aliases(mock_gateway, "UnknownSKU")
        self.assertEqual(result, ["UnknownSKU"])

    def test_resolve_sku_group_for_matching(self):
        mock_gateway = MagicMock()
        mock_gateway._fetch_all.return_value = [
            {"primary_sku": "AC-S02", "aliases": ["Acme A100"]}
        ]
        mapping = resolve_sku_group_for_matching(mock_gateway, ["Acme A100", "AC-S02"])
        self.assertEqual(mapping.get("Acme A100"), "AC-S02")
        self.assertEqual(mapping.get("AC-S02"), "AC-S02")

    def test_get_sku_references_query_structure(self):
        mock_repo = MagicMock()
        mock_repo.fetch_all.return_value = [
            {"embedding": "[0.1, 0.2]", "source_url": "https://example.com/img.jpg", "is_primary": True}
        ]
        settings = MagicMock()
        settings.database_url = "postgresql://test/db"
        mock_storage = MagicMock()
        gateway = NativeGateway(settings, repository=mock_repo, storage=mock_storage)

        refs = gateway.get_sku_references("Acme A100")
        self.assertEqual(len(refs), 1)

        sql_call = mock_repo.fetch_all.call_args
        query_sql, params = sql_call[0]
        self.assertIn("r.sku in", query_sql)
        self.assertIn("p.primary_sku = %s", query_sql)
        self.assertIn("any(p.aliases)", query_sql)
        self.assertEqual(params[1], "Acme A100")


if __name__ == "__main__":
    unittest.main()
