"""Apply additive PostgreSQL-native migrations exactly once.

Usage (from ``backend/``):
    python -m scripts.apply_native_migrations --dry-run
    python -m scripts.apply_native_migrations

The script reads ``DATABASE_URL`` and never prints it. It is intentionally
separate from retired migration tooling so database targets cannot be mixed
accidentally.
"""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path

import psycopg2

import sys
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from app.postgres_repository import PostgresConfigurationError, PostgresSettings


DEFAULT_MIGRATIONS_DIR = ROOT / "migrations"

# P1/P2/P3 are not allowed to introduce production schema changes.  The live
# ledger audit on 2026-08-28 verified applied history through 0021.
#
# Migration 0022 (versioned embedding spaces) was initially authorized for a
# explicit scope by a Product Lead policy override recorded at
# plans/2026-08-28-siglip2-versioned-space-migration/phase-04-go-no-go-decision.md
# (2026-09-05, demo.user@example.com). That record is honest about what it is NOT:
# there is still no P3 tournament evidence (P3 status remains
# BLOCKED_BEFORE_INFERENCE) and P2 is still not canonically closed (414 human
# review decisions + 300 G5 hard-open-set images outstanding). The override
# initially unlocked Phase 5A/5B/5C (this schema) + Phase 6 (backfill) + Phase 7A
# (Release A: nl_search_space_id only, active_space_id stays DataComp — zero
# SKU-recognition risk). The later production lifecycle decision is recorded
# separately in the project ADRs. It does not
# change this runner's checksum or migration ordering rules.
#
# Do not raise this constant again for any migration beyond 0027 without a
# comparable explicit, evidenced record.
#
# Migration 0023 (media_renditions for Image SEO V2) is authorized by an explicit
# ADR at plans/2026-09-07-canonical-media-publication-pipeline/ADR-0023-media-renditions.md.
# It introduces the media_renditions table for multi-size WebP publication and does
# not touch embedding spaces or SigLIP2 tournaments.
#
# Migration 0024 (verity_upload_context_config) adds a singleton-row config table for
# dynamic batch upload presets and tag groups managed via Settings.
#
# Migration 0025 (verity_search_config) is the additive search-ranking and
# semantic-channel configuration table.  Migration 0024 is intentionally kept
# unchanged because its namespace is already occupied by upload-context config.
# The split is recorded in plans/2026-09-07-image-enrichment-retrieval-hub/
# ADR-0025-search-config.md.
#
# Migration 0026 (source_import_provenance) adds source_provider, source_file_id,
# source_modified_time, import_batch_id, source_md5 to media_assets with a unique
# index for exactly-once external imports (Google Drive, Zalo).
# Approved in plan: Dev curated bulk-import (2026-09-08).
#
# Migration 0027 adds the durable server-side batch archive job state used by
# the responsive Library export flow. It is intentionally independent from
# the Python ingest queue and has no embedding/search implications.
#
# Migration 0028 adds visible_text text[] to media_assets to preserve OCR
# text extracted from product logos and labels by AI Vision. Migration 0029
# is the separately approved universal canonical-media pipeline: additive
# rendition/job state only; originals stay immutable at storage_path. See
# plans/2026-09-08-universal-canonical-media-pipeline/ADR-0029-universal-canonical-media.md.
# Migration 0030 adds the persisted duplicate-photo workbench. It is additive
# side-table state only; media_dedup_matches remains the evidence ledger.
# See plans/2026-09-08-duplicate-photo-workbench/ADR-0030-media-dedup-workbench.md.
#
# Migration 0031 adds license/licensor URLs to verity_metadata_defaults_config.
# Migration 0032 adds build_version to media_dedup_clusters for isolated lane semantics.
# Migration 0033 adds the durable Better Auth login/logout audit ledger. It is
# intentionally independent from the media, embedding, and search planes.
#
# Migration 0034 adds the durable operational audit ledger (mcp_tool_call_log)
# for VerityDAM MCP tool calls. It is append-only, stores sanitized payloads
# only, and is intentionally independent from the media, embedding, and search planes.
#
# Migration 0035 adds the channel-aware usage-history index (idx_media_usages_asset_channel_date)
# on public.media_usages for fast MCP image rotation queries.
# 0037 is the separately scoped product-intake workflow: additive intake/audit
# tables, a narrow open-intake guard, and one worker job kind. See
# docs/adr/0037-product-intake-workflow.md. It does not mutate historical
# corpus rows or embedding-space identity.
#
# Migration 0038 adds the needs_post_production boolean column to public.media_assets
# to flag assets requiring manual retouching or post-production processing.
# See docs/adr/0038-media-needs-post-production.md.
#
# Migration 0039 adds asset_reports and asset_report_events for tracking quality,
# SKU, metadata, and URL correctness reports and their lifecycle audit events.
# Migration 0040 adds the image_category column on public.sku_references.
# Migration 0041 fixes trg_enqueue_canonical_media_publication to fire on any update.
# Migration 0042 standardizes space and status taxonomy and media assets values.
# Migration 0043 enriches product intake declaration flow for reference-embedding learning.
# Migrations 0044-0049 add the isolated creative pipeline, its DB-owned
# review/synthetic safeguards, explicit Library eligibility, and the encrypted
# Settings-managed provider configuration. They do not alter frozen embedding
# vectors or repurpose media_ingest_jobs.
#
# Migration 0050 adds the external API Key authorization ledger (mcp_api_keys)
# for VerityDAM MCP Server HTTP Bearer authentication.
# Migration 0051 standardizes all media assets to public permission.
# Migration 0052 adds MCP governance: revokes the 0050 seed key whose raw token
# is committed in that file, key expiry/rotation columns, per-key attribution in
# mcp_tool_call_log, and the mcp_tool_settings kill-switch table.
# Migration 0053 adds the Better Auth OAuth 2.1 provider tables (jwks, oauth*)
# so MCP clients can connect with login + consent instead of an API key.
# Later migrations remain blocked until reviewed.
FROZEN_MAX_NATIVE_MIGRATION_ID = 53
_MIGRATION_NAME = re.compile(r"^(?P<number>[0-9]+)_[^/]+\.sql$")

# 0003 was applied by an early native release before taxonomy cleanup was
# moved into the additive 0004 migration.  Its SQL body was corrected in git
# after that release, so the historical checksum is intentionally accepted
# once and rewritten to the current checksum.  No other checksum drift is
# tolerated: an unexpected edit still stops deployment before SQL runs.
KNOWN_CHECKSUM_REWRITES: dict[str, dict[str, set[str]]] = {
    "0003_native_media_schema.sql": {
        # The first value is the checksum recorded by the live database.
        "d9599c7a29ce488eb8c992712688e71f8f8e8406c2403e3cff1500f913563bff": {
            "929632b2bc8b8134122d94e9ba20a93529b90f0f255ca218ab2857aea987ca92",
            # A previously built image contains the same SQL with the
            # historical checkout's line-ending normalization.
            "131a6bd303b3935a245e88747193dcf9787a29ce05d156f57341e4b49f94d441",
        },
        # If that image reconciles the row first, a later release may see
        # 131a6bd... as the stored value and must converge it to HEAD.
        "131a6bd303b3935a245e88747193dcf9787a29ce05d156f57341e4b49f94d441": {
            "929632b2bc8b8134122d94e9ba20a93529b90f0f255ca218ab2857aea987ca92",
        },
    },
    "0004_remove_taxonomy_hotkeys.sql": {
        "7f7b846dc7fc216a9a52544cf0a24b578cfcfa1a89ecd76db42a5ef884442b3b": {
            "e4619ad5cb8bdca75ac12fa94838d18d1f38dbf8b20201e10417a66b610375af",
        },
    },
    "0005_soft_delete_media_assets.sql": {
        "76339a98ce3009a14659d097add997776719fb42ba8c518d6bc7e910e2064ded": {
            "bf947acd1563c87b34beddc534d171db69928674e1386cabb996a93fa5a15e3c",
        },
    },
    "0006_expand_brand_taxonomy.sql": {
        "72573d904615b5b7b200b226814ef3eda86ba11f739f8b2dde7c4779158be8b3": {
            "bee1344d8cdc5c5c5320f7385d3d29ea06c1efb8022e712798d3398b692ce224",
        },
        # A native release recorded the Windows-normalized working-tree hash
        # before the archive build restored the repository's LF blob.  Accept
        # this one known representation and converge the state to the archive
        # checksum used by all subsequent releases.
        "4d562033ef8c70d37ffeed233c85662e37d0ef636b62386d490012239d3ac1d": {
            "bee1344d8cdc5c5c5320f7385d3d29ea06c1efb8022e712798d3398b692ce224",
        },
    },
    "0007_expand_brand_aliases.sql": {
        # Same one-time Windows-normalized checksum drift as migration 0006.
        "87c21877dd5f2ad8a1c7d342992098c6205deb3dd0c892175f84510302e5fe1d": {
            "38cb2e33aa06d0824c003b6e53fe5f62ca403e8139e0591124c5b9dcff2b15dc",
        },
    },
    "0008_expand_catalog_brand_taxonomy.sql": {
        # This additive catalog migration was applied once from the Windows
        # working tree before the release archive normalized line endings.
        "e9bef429b492f721002f78369912c2eb05792bebc3845e7df20bce81f7b6cb42": {
            "0591cf9e0555bf145179128de3c6df69ed92568d6722ff7a7551931b6d0ed190",
        },
    },
    "0018_canonical_b32_production_schema.sql": {
        "347b325ed8ef5417afac1a211c0a3fcce2aa896c63bb429de9270b6a044ec0de": {
            "5942929d0b83e012f33684bf61f3654abee3f3a5a244a19ec9e265aea579c71d",
        },
    },
    "0022_siglip2_versioned_space_schema.sql": {
        # Initial version of 0022 used l2_norm() before being corrected to
        # vector_norm() for pgvector compatibility in commit 711529c.
        "bda97d3f531447e1e829ff77a593661a0ce3a6559601b54942854d5941ae5d6e": {
            "60fc9d9501104f39d268a7f07c53d3e1220fc77fd174b967ee8c62c3b3e5b595",
        },
    },
}


def _database_url() -> str:
    try:
        return PostgresSettings.from_environment().database_url
    except PostgresConfigurationError as error:
        raise SystemExit(str(error)) from error


def _migration_files(directory: Path) -> list[Path]:
    files = sorted(directory.glob("*.sql"))
    if not files:
        raise SystemExit(f"No native migrations found in {directory}")
    future = []
    for file in files:
        match = _MIGRATION_NAME.match(file.name)
        if match is None:
            raise SystemExit(f"Invalid native migration filename: {file.name}")
        if int(match.group("number")) > FROZEN_MAX_NATIVE_MIGRATION_ID:
            future.append(file.name)
    if future:
        raise SystemExit(
            f"Native migration freeze is active through {FROZEN_MAX_NATIVE_MIGRATION_ID:04d}; "
            "blocked future migration(s): "
            + ", ".join(future)
        )
    return files


def _migration_bytes(file: Path) -> bytes:
    """Return canonical LF bytes for stable checksums across Windows archives."""
    return file.read_bytes().replace(b"\r\n", b"\n")


def _assert_applied_sources_are_present(known: dict[str, str], files: list[Path]) -> None:
    """Fail closed when the ledger contains an unknown migration source."""

    source_names = {file.name for file in files}
    missing_sources = sorted(set(known) - source_names)
    if missing_sources:
        raise SystemExit(
            "Applied native migration source is outside the current runner scope; "
            "explicit reconciliation required: "
            + ", ".join(missing_sources)
        )


def apply(directory: Path, dry_run: bool = False) -> list[str]:
    files = _migration_files(directory)
    if dry_run:
        return [file.name for file in files]

    dsn = _database_url()
    applied: list[str] = []
    with psycopg2.connect(dsn) as connection:
        with connection.cursor() as cursor:
            # Serialize operators so two deploys cannot race the same state.
            cursor.execute("select pg_advisory_xact_lock(hashtext(%s))", ("verity-native-migrations",))
            cursor.execute("select to_regclass('verity.migration_state')")
            state_table_exists = cursor.fetchone()[0] is not None
            known: dict[str, str] = {}
            if state_table_exists:
                cursor.execute(
                    """
                    select 1
                    from information_schema.columns
                    where table_schema = 'verity'
                      and table_name = 'migration_state'
                      and column_name = 'checksum'
                    """
                )
                if cursor.fetchone() is None:
                    raise SystemExit(
                        "verity.migration_state lacks checksum; inspect/backup the old state before continuing"
                    )
                cursor.execute("select migration_id, checksum from verity.migration_state")
                known = {row[0]: row[1] for row in cursor.fetchall()}
            _assert_applied_sources_are_present(known, files)

            for file in files:
                raw_checksum = hashlib.sha256(file.read_bytes()).hexdigest()
                checksum = hashlib.sha256(_migration_bytes(file)).hexdigest()
                if file.name in known:
                    if known[file.name] != checksum:
                        # Existing releases may have recorded the exact CRLF
                        # bytes extracted on Windows.  Treat that representation
                        # as equivalent and converge the state row to the
                        # canonical LF checksum used by source control.
                        if known[file.name] == raw_checksum:
                            cursor.execute(
                                """
                                update verity.migration_state
                                   set checksum = %s,
                                       notes = coalesce(notes, '') || '; checksum normalized to canonical LF'
                                 where migration_id = %s
                                """,
                                (checksum, file.name),
                            )
                            applied.append(f"{file.name} (checksum normalized)")
                            continue
                        rewritten = KNOWN_CHECKSUM_REWRITES.get(file.name, {}).get(known[file.name], set())
                        if checksum not in rewritten:
                            raise SystemExit(f"Migration checksum changed after apply: {file.name}")
                        cursor.execute(
                            """
                            update verity.migration_state
                            set checksum = %s,
                                notes = coalesce(notes, '') || '; checksum reconciled after additive migration correction'
                            where migration_id = %s
                            """,
                            (checksum, file.name),
                        )
                        applied.append(f"{file.name} (checksum reconciled)")
                    continue
                if file.name.startswith("0014_"):
                    # Migration 0014 alters sku_reference_embeddings_shadow, which was
                    # introduced as an unnumbered shadow trial table before 0014.
                    shadow_sql_path = ROOT / "app" / "migrations" / "create_shadow_tables.sql"
                    if shadow_sql_path.is_file():
                        cursor.execute(shadow_sql_path.read_text(encoding="utf-8-sig"))

                cursor.execute(file.read_text(encoding="utf-8-sig"))
                # The first migration creates this table; later migrations use
                # the same state record.  Keep the insert parameterized.
                cursor.execute(
                    "insert into verity.migration_state (migration_id, checksum, notes) values (%s, %s, %s)",
                    (file.name, checksum, "applied by scripts.apply_native_migrations"),
                )
                applied.append(file.name)
    return applied


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=DEFAULT_MIGRATIONS_DIR)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    result = apply(args.directory, dry_run=args.dry_run)
    if args.dry_run:
        print("Native migrations:")
        for name in result:
            print(f"- {name}")
    elif result:
        print(f"Applied {len(result)} native migration(s).")
    else:
        print("Native migrations already up to date.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
