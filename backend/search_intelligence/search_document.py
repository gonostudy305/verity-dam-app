"""Common, offline search-document representation.

:class:`SearchDocument` mirrors ONLY the fields already available to the
current production search path (see
``docs/search/VIETNAMESE_SEARCH_ARCHITECTURE.md`` -- the ``listWhere()``
ILIKE fields plus the two sort keys it already uses). It has no DB
dependency and performs no auth/permission check of its own -- permission
filtering happens upstream, before a document is ever handed to this
retrieval/ranking layer (see ``docs/search/PERMISSION_ORDER.md`` /
``search_intelligence.permission`` for that contract). This is a pure,
offline data-carrier type used by every channel/fusion/reranker module in
this checkpoint.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SearchDocument:
    """One media/product asset as the search layer sees it.

    Every field here already exists on the production `verity_media_assets`
    row and is already read by ``listNativeLibraryMedia``/``listWhere()``
    -- this dataclass adds no new data source, it just gives the offline
    Python search-intelligence layer the same shape without a DB
    dependency.
    """

    asset_id: str
    title: str = ""
    sku: str = ""
    brand: str = ""
    category: str = ""
    space: str = ""
    suggested_caption: str = ""
    keywords: tuple[str, ...] = field(default_factory=tuple)
    usage_count: int = 0
    created_at: str = ""  # ISO-8601 string; offline layer never parses/compares as a real datetime
