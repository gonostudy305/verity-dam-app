"""Search Intelligence Checkpoint 1 (offline library code).

This package is an OFFLINE, non-production set of typed modules that will
eventually sit in front of the existing production ILIKE search path
(``src/lib/server/native-media.ts`` / ``native-synonyms.ts``). Nothing in
this package is wired into the production endpoint yet -- it is a pure
library: normalization, rule-based query classification, entity/SKU
extraction, a Vietnamese-tuned typo/fuzzy candidate generator, and an
offline evaluation schema.

Hard boundaries for this checkpoint (see docs/search/VIETNAMESE_SEARCH_ARCHITECTURE.md):
  * No Learning-to-Rank model is trained or built here.
  * No human relevance labels are fabricated; Suite C 0-3 grades do not
    exist yet and are a hard prerequisite for any future ML training.
  * All vocabulary (brands, SKUs, categories, spaces, features, protocols)
    is derived only from real, observed repository/business data -- never
    invented and never LLM-hallucinated. See ``vocabulary.py`` for exact
    provenance of every list.
  * This Python package itself is not wired into the production endpoint.
    Production deployment, selector, schema and default production
    behavior are untouched. Production source code IS modified elsewhere
    (the TypeScript `/api/media` route and `native-media.ts`, via the R0.1
    gateway), but only behind a default-off fail-safe feature flag
    (`Verity_SEARCH_INTELLIGENCE_V1_ENABLED`, defaults false); with the flag
    off, behavior is provably identical to `BASELINE_L0` (see the
    architecture doc).
"""

from __future__ import annotations
