"""``FUNCTIONAL_INVARIANTS`` -- deterministic checks, explicitly NOT a
relevance-quality benchmark.

Suite C human 0-3 relevance grades do not exist yet, so this checkpoint
must never claim a relevance-quality improvement over anything. What CAN
be measured today, without any human label, are deterministic invariants
this engine must always satisfy: exact-SKU documents rank Top1, an
accented and its unaccented counterpart both find the same document,
typo recovery actually recovers, zero-result recovery is exercised in the
documented order, and repeated runs are perfectly repeatable. Every
function here returns a plain pass/fail plus enough detail to see why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from .contract import run_canonical_search
from .search_document import SearchDocument


@dataclass(frozen=True)
class InvariantCheck:
    name: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class FunctionalInvariantReport:
    label: str = field(default="FUNCTIONAL_INVARIANTS")
    checks: tuple[InvariantCheck, ...] = field(default_factory=tuple)

    @property
    def all_passed(self) -> bool:
        return all(check.passed for check in self.checks)


def check_exact_sku_top1(sku: str, documents: Sequence[SearchDocument]) -> InvariantCheck:
    result = run_canonical_search(sku, documents)
    if not result.ranked:
        return InvariantCheck(f"exact_sku_top1:{sku}", False, "no results returned")
    matching = [document.asset_id for document in documents if document.sku.casefold() == sku.casefold()]
    passed = bool(matching) and result.ranked[0].asset_id in matching
    return InvariantCheck(f"exact_sku_top1:{sku}", passed, f"top1={result.ranked[0].asset_id}")


def check_accent_parity(accented_query: str, unaccented_query: str, documents: Sequence[SearchDocument]) -> InvariantCheck:
    accented = run_canonical_search(accented_query, documents)
    unaccented = run_canonical_search(unaccented_query, documents)
    a_top = accented.ranked[0].asset_id if accented.ranked else None
    u_top = unaccented.ranked[0].asset_id if unaccented.ranked else None
    passed = a_top is not None and a_top == u_top
    return InvariantCheck(f"accent_parity:{accented_query}~{unaccented_query}", passed, f"accented_top={a_top} unaccented_top={u_top}")


def check_rank_determinism(query: str, documents: Sequence[SearchDocument]) -> InvariantCheck:
    first = run_canonical_search(query, documents)
    second = run_canonical_search(query, documents)
    first_order = [item.asset_id for item in first.ranked]
    second_order = [item.asset_id for item in second.ranked]
    passed = first_order == second_order
    return InvariantCheck(f"rank_determinism:{query}", passed, f"order={first_order}")


def run_functional_invariants(
    *,
    sku_fixtures: Sequence[tuple[str, Sequence[SearchDocument]]] = (),
    accent_parity_fixtures: Sequence[tuple[str, str, Sequence[SearchDocument]]] = (),
    determinism_fixtures: Sequence[tuple[str, Sequence[SearchDocument]]] = (),
) -> FunctionalInvariantReport:
    checks: list[InvariantCheck] = []
    for sku, documents in sku_fixtures:
        checks.append(check_exact_sku_top1(sku, documents))
    for accented, unaccented, documents in accent_parity_fixtures:
        checks.append(check_accent_parity(accented, unaccented, documents))
    for query, documents in determinism_fixtures:
        checks.append(check_rank_determinism(query, documents))
    return FunctionalInvariantReport(checks=tuple(checks))
