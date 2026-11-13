from __future__ import annotations

from pathlib import Path

from verity_dam_mcp import sku_match_receiver


class _Repository:
    def __init__(self) -> None:
        self.query = ""
        self.params = ()

    def fetch_all(self, query: str, params: tuple[object, ...]) -> list[dict[str, object]]:
        self.query = query
        self.params = params
        return []


class _Gateway:
    def __init__(self) -> None:
        self.repository = _Repository()


def test_matcher_requires_a_primary_reference_anchor() -> None:
    gateway = _Gateway()

    assert sku_match_receiver.match(gateway, [0.0] * sku_match_receiver.DIMENSION) == []
    assert "raw_candidates" in gateway.repository.query
    assert "s.similarity" in gateway.repository.query
    assert len(gateway.repository.params) == 4


def test_primary_repair_migration_backfills_and_protects_the_invariant() -> None:
    migration = Path(__file__).parents[1] / "migrations" / "0036_sku_reference_primary_integrity.sql"
    sql = migration.read_text(encoding="utf-8")

    assert "row_number() OVER" in sql
    assert "reference_role = 'HERO'" in sql
    assert "uq_sku_references_one_primary_eligible" in sql
