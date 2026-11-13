"""Suite C bridge -- INTERFACE ONLY. No labels exist or are written here.

This defines the canonical future schema a real Suite C human-relevance
labeling effort would produce, and a stub importer shape a future
pipeline could implement to turn that schema into
:class:`~search_intelligence.evaluator.RelevanceJudgment` rows. Nothing in
this module reads, writes, or fabricates a single real judgment --
``HUMAN_SUITE_C_LABELS_AVAILABLE`` stays ``False`` for the whole of this
checkpoint, and any code path that would need real labels (a real
:func:`~search_intelligence.evaluator.evaluate` call with non-empty
judgments, or any LTR training) simply does not run.

Grouped-split requirement (documented for a FUTURE LTR mission, not
implemented here since there is no data to split yet): every accented and
unaccented variant of the SAME underlying search intent must stay in the
SAME train/validation/test split. Splitting one variant into train and its
accented/unaccented sibling into test would let a future model see the
"answer" for a held-out intent via its paired query, silently inflating
apparent quality. ``intent_group_id`` below exists specifically to let a
future splitter group on it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

HUMAN_SUITE_C_LABELS_AVAILABLE = False


@dataclass(frozen=True)
class SuiteCRow:
    """One future Suite C human-graded row. THIS SCHEMA HOLDS NO REAL DATA
    anywhere in this checkpoint -- it is written here purely so a future
    labeling effort has an agreed-upon shape to target, and so
    :class:`SuiteCImporter` has a concrete type to convert from."""

    query_id: str
    intent_group_id: str  # groups accented/unaccented/typo variants of the SAME underlying intent -- see module docstring
    query_text: str
    grade: int  # 0-3, same scale as search_intelligence.evaluator.RelevanceJudgment
    asset_id: str
    reviewer_id: str
    reviewed_at: str  # ISO-8601 string

    def __post_init__(self) -> None:
        if not 0 <= self.grade <= 3:
            raise ValueError(f"Suite C grade must be 0-3, got {self.grade!r}")


class SuiteCImporter(Protocol):
    """Interface a future importer would implement to turn real Suite C
    rows into :class:`~search_intelligence.evaluator.RelevanceJudgment`
    objects. No implementation exists in this checkpoint -- there is no
    data to import."""

    def import_rows(self, rows: Sequence[SuiteCRow]) -> Sequence["RelevanceJudgmentLike"]: ...


class RelevanceJudgmentLike(Protocol):
    query_id: str
    doc_id: str
    grade: int


def assert_no_suite_c_labels_exist() -> None:
    """A single, explicit, checkable assertion point every caller in this
    checkpoint can rely on -- flips to unsafe the moment (and only the
    moment) a future mission intentionally changes
    ``HUMAN_SUITE_C_LABELS_AVAILABLE``."""

    if HUMAN_SUITE_C_LABELS_AVAILABLE:
        raise RuntimeError(
            "HUMAN_SUITE_C_LABELS_AVAILABLE is True but this checkpoint assumes it is always False"
        )
