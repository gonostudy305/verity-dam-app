# ADR-0032: Materialized dedup cluster semantics v2

Date: 2026-09-09
Status: accepted

## Decision

Authorize the additive migration `0032_media_dedup_cluster_semantics_v2.sql`.
It adds a positive `build_version` to `media_dedup_clusters`, allowing the
application to invalidate and rebuild only open, materialized review work when
cluster interpretation changes. Closed audit records remain unchanged.

## Governance

This migration changes neither the immutable duplicate-evidence ledger
(`media_dedup_matches`) nor any asset. It does not introduce a delete path,
embedding runtime change, or search change. The source hash is pinned in
`backend/scripts/release_a_selector_validator.py`; an unknown or changed
migration continues to fail closed before deployment.
