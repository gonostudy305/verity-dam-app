"""PostgreSQL + Cloudflare R2 gateway used by the native worker runtime.

The worker keeps a small gateway surface while moving all durable job state and
metadata updates into parameterized PostgreSQL transactions.
Object bytes and signed URLs are served through Cloudflare R2.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from typing import Any, Mapping, Sequence

from app.gateway_errors import GatewayError
from app.catalog_text import sanitize_brand_prior, text_query_variants
from app.postgres_repository import PostgresRepository, PostgresSettings
from app.production_config import PRODUCTION_EMBEDDING_MODEL, PRODUCTION_EMBEDDING_VERSION, WorkerSettings
from app.r2_storage import R2Settings, R2Storage
from app.space_resolver import DEFAULT_ACTIVE_SPACE_ID, SpaceResolver

_LEGACY_DATACOMP_SPACE_ID = "verity-openclip-b32-datacomp-256-v1"
_PROVIDER = "local_openclip"
_DEFAULT_SPACE_ID = DEFAULT_ACTIVE_SPACE_ID
_SPACE_ID = _DEFAULT_SPACE_ID
_DIMENSION = 512


def _json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"), ensure_ascii=False)


def _vector(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Sequence):
        return "[" + ",".join(format(float(item), ".9g") for item in value) + "]"
    raise GatewayError("Embedding value is not a vector")


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _nullable_text(value: Any) -> str | None:
    """Return stripped string or None if empty or non-string.
    CRITICAL FOR POSTGRESQL: In PostgreSQL, '' IS NOT NULL evaluates to TRUE!
    Never pass an empty string '' to an SQL 'is not null' condition without nullif(trim(...), '').
    """
    if isinstance(value, str):
        val = value.strip()
        return val if val else None
    return None


def _dict_row(row: Any, columns: Sequence[str]) -> dict[str, Any] | None:
    if row is None:
        return None
    if isinstance(row, Mapping):
        return dict(row)
    values = list(row)
    return {column: values[index] for index, column in enumerate(columns) if index < len(values)}


def _valid_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _active_duplicate_matches(matches: Any, active_ids: set[str]) -> list[dict[str, Any]]:
    """Keep only well-formed duplicate hits whose assets are still active.

    Candidate searches and job completion run in separate transactions.  An
    administrator can therefore soft-delete a candidate between those two
    operations.  Filtering again before writing the review summary prevents a
    stale deleted id from becoming an operational duplicate warning.
    """

    if not isinstance(matches, list):
        return []
    return [
        item
        for item in matches
        if isinstance(item, dict)
        and _valid_uuid(item.get("candidate_media_asset_id"))
        and str(uuid.UUID(str(item["candidate_media_asset_id"]))) in active_ids
    ]


class NativeGateway:
    """Worker data boundary backed by ``PostgresRepository`` and ``R2Storage``."""

    def __init__(
        self,
        settings: WorkerSettings,
        repository: PostgresRepository | Any | None = None,
        storage: R2Storage | Any | None = None,
        space_resolver: SpaceResolver | None = None,
    ) -> None:
        self.settings = settings
        if repository is None:
            if not settings.database_url:
                raise GatewayError("DATABASE_URL is required for the native worker")
            repository = PostgresRepository(
                PostgresSettings(
                    database_url=settings.database_url,
                    min_connections=settings.db_min_connections,
                    max_connections=settings.db_max_connections,
                    connect_timeout=settings.db_connect_timeout,
                )
            )
        self.repository = repository
        if storage is None:
            if not settings.r2_is_configured:
                raise GatewayError(
                    "R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are required"
                )
            storage = R2Storage(
                R2Settings(
                    endpoint=settings.r2_endpoint or "",
                    access_key_id=settings.r2_access_key_id or "",
                    secret_access_key=settings.r2_secret_access_key or "",
                    bucket=settings.r2_bucket or "",
                    region=settings.r2_region,
                    public_base_url=settings.r2_public_base_url,
                )
            )
        self.storage = storage
        self.space_resolver = space_resolver or SpaceResolver(self.repository)

    def close(self) -> None:
        close = getattr(self.repository, "close", None)
        if callable(close):
            close()

    def _fetch_one(self, query: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        try:
            return self.repository.fetch_one(query, params)
        except Exception as error:
            raise GatewayError(f"PostgreSQL query failed: {type(error).__name__}: {error}") from error

    def _fetch_all(self, query: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        try:
            return self.repository.fetch_all(query, params)
        except Exception as error:
            raise GatewayError(f"PostgreSQL query failed: {type(error).__name__}: {error}") from error

    def _transaction(self, query: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        """Execute a one-row transaction while normalizing tuple cursors."""

        try:
            with self.repository.transaction() as cursor:
                cursor.execute(query, params)
                row = cursor.fetchone()
                description = getattr(cursor, "description", None) or ()
                columns = [item[0] for item in description]
                return _dict_row(row, columns)
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"PostgreSQL transaction failed: {type(error).__name__}: {error}") from error

    def claim_job(self) -> dict[str, Any] | None:
        row = self._transaction(
            """
            with candidate as (
                select j.id
                from public.media_ingest_jobs j
                join public.media_assets a on a.id = j.media_asset_id
                where j.run_after <= now()
                  and a.deleted_at is null
                  and j.attempts < j.max_attempts
                  and (j.status = 'queued' or
                       (j.status = 'processing' and j.locked_at < now() - (%s * interval '1 second')))
                order by j.created_at asc
                for update skip locked
                limit 1
            )
            update public.media_ingest_jobs j
            set status = 'processing', attempts = j.attempts + 1,
                locked_at = now(), locked_by = %s, error_message = null, updated_at = now()
            from candidate c
            where j.id = c.id
            returning j.id, j.media_asset_id, j.job_kind, j.payload, j.attempts
            """,
            (300, self.settings.worker_id),
        )
        return row

    def get_media_asset(self, media_asset_id: str) -> dict[str, Any]:
        row = self._fetch_one(
            "select * from public.media_assets where id = %s and deleted_at is null limit 1",
            (media_asset_id,),
        )
        if not row:
            raise GatewayError(f"Media asset {media_asset_id} no longer exists")
        return row

    def get_license_config(self) -> dict[str, Any]:
        """Fetch org-wide license defaults from verity_metadata_defaults_config."""
        row = self._fetch_one(
            "select license_url, web_statement_url, licensor_name, licensor_url, acquire_license_page "
            "from public.verity_metadata_defaults_config where config_key = 'default' limit 1"
        )
        return row or {}

    def download_object(self, storage_path: str) -> bytes:
        try:
            return self.storage.get_bytes(storage_path)
        except Exception as error:
            raise GatewayError(f"R2 object read failed: {type(error).__name__}: {error}") from error

    def presign_download_url(self, storage_path: str, expires_in: int = 900) -> str:
        try:
            owner_prefix = storage_path.split('/', 1)[0]
            return self.storage.presign_download(storage_path, scope_prefix=owner_prefix, expires_in=expires_in)
        except Exception as error:
            raise GatewayError(f"R2 signed URL creation failed: {type(error).__name__}: {error}") from error

    def metadata_examples(self) -> list[dict[str, Any]]:
        return self._fetch_all(
            """
            select source_media_asset_id, input_context, accepted_metadata
            from public.metadata_few_shot_examples
            where is_active
              and (source_media_asset_id is null or exists (
                select 1 from public.media_assets a
                where a.id = source_media_asset_id
                  and a.deleted_at is null
                  and coalesce(a.ai_flags -> 'is_ai', 'false'::jsonb) <> 'true'::jsonb
              ))
            order by created_at desc
            limit %s
            """,
            (8,),
        )

    def taxonomy_options(self) -> list[dict[str, Any]]:
        rows = self._fetch_all(
            """
            select facet, value, label, sort_order, is_active
            from public.verity_taxonomy_options
            where is_active = true
            order by facet asc, sort_order asc, label asc
            limit 300
            """
        )
        if not rows:
            raise GatewayError("Shared taxonomy configuration is not configured")
        facets = {row.get("facet") for row in rows}
        if not {"category", "space", "status", "brand"}.issubset(facets):
            raise GatewayError("Shared taxonomy configuration is incomplete")
        return rows

    def shared_vision_config(self) -> dict[str, Any]:
        row = self._fetch_one(
            """
            select base_url, model, image_detail, max_tokens, system_prompt,
                   api_key_ciphertext, api_key_nonce, api_key_auth_tag, encryption_version
            from public.verity_ai_vision_config
            where config_key = 'default' and active = true
            limit 1
            """
        )
        if not row:
            raise GatewayError("Shared Vision configuration is not configured")
        return row

    def shared_embedding_config(self) -> dict[str, Any]:
        row = self._fetch_one(
            """
            select base_url, model, embedding_version, embedding_dimension,
                   api_key_ciphertext, api_key_nonce, api_key_auth_tag, encryption_version
            from public.verity_ai_embedding_config
            where config_key = 'default' and active = true
            limit 1
            """
        )
        if not row:
            raise GatewayError("Shared Embedding configuration is not configured")
        return row

    def match_sku_reference_candidates(
        self, embedding: Any, match_count: int = 20, space_id: str | None = None, brand: str | None = None
    ) -> list[dict[str, Any]]:
        target_space = space_id or self.space_resolver.get_active_space_id()
        brand_param = sanitize_brand_prior(brand)
        return self._fetch_all(
            """
            with raw_hits as (
                select r.sku, re.vector <=> %s::vector as dist
                from public.reference_embeddings re
                join public.sku_references r on r.reference_id = re.reference_id
                where re.space_id = %s
                  and r.is_active = true
                  and r.match_eligible = true
                order by dist
                limit least(greatest(%s * 8, 80), 300)
            ),
            raw_candidates as (
                select sku, min(dist) as min_dist
                from raw_hits
                group by sku
                order by min_dist
                limit least(greatest(%s * 2, 30), 100)
            ),
            scored as (
                select c.sku,
                       (1 - c.min_dist)::real as similarity
                from raw_candidates c
            )
            select s.sku,
                   s.similarity
            from scored s
            left join lateral (
                select brand
                from public.verity_products
                where lower(primary_sku) = lower(s.sku)
                   or lower(code) = lower(s.sku)
                   or s.sku = any(aliases)
                order by (lifecycle = 'active') desc, updated_at desc
                limit 1
            ) p on true
            order by (case when %s::text is not null and p.brand is not null and lower(trim(p.brand)) = lower(trim(%s::text)) then 1 else 0 end) desc,
                     s.similarity desc, s.sku
            limit least(greatest(%s, 2), 50)
            """,
            (
                _vector(embedding), target_space, match_count,
                match_count,
                brand_param, brand_param,
                match_count,
            ),
        )

    def match_catalog_text_candidates(self, text_values: Sequence[object], match_count: int = 20) -> list[dict[str, Any]]:
        """Find catalog products whose SKU/model/title contains observed text."""

        variants = text_query_variants(text_values)
        if not variants:
            return []
        safe_limit = min(max(int(match_count), 2), 50)
        return self._fetch_all(
            """
            select p.primary_sku as sku,
                   case
                     when lower(trim(coalesce(p.primary_sku, ''))) = any(%s::text[]) then 1.0
                     when lower(trim(coalesce(p.model_name, ''))) = any(%s::text[]) then .95
                     when lower(trim(coalesce(p.code, ''))) = any(%s::text[]) then .90
                     else .75
                   end as text_score,
                   coalesce(nullif(p.primary_sku, ''), nullif(p.model_name, ''), p.display_name) as text_evidence
            from public.verity_products p
            where p.lifecycle = 'active'
              and (
                lower(trim(coalesce(p.primary_sku, ''))) = any(%s::text[])
                or lower(trim(coalesce(p.model_name, ''))) = any(%s::text[])
                or lower(trim(coalesce(p.code, ''))) = any(%s::text[])
                or exists (
                  select 1 from unnest(%s::text[]) q
                  where position(lower(q) in lower(coalesce(p.display_name, ''))) > 0
                )
              )
            order by text_score desc, p.updated_at desc, p.primary_sku
            limit %s
            """,
            (variants, variants, variants, variants, variants, variants, variants, safe_limit),
        )

    def match_scene_duplicate_candidates(
        self,
        media_asset_id: str,
        embedding: Any,
        threshold: float | None = None,
        match_count: int = 10,
        space_id: str | None = None,
    ) -> list[dict[str, Any]]:
        active_space = space_id or self.space_resolver.get_active_space_id()
        if threshold is None or float(threshold) <= 0:
            calib = self.space_resolver.get_space_calibration(active_space)
            threshold = calib.get("scene_duplicate_threshold", 0.92)
        effective_threshold = float(threshold)
        return self._fetch_all(
            """
            select a.id as candidate_media_asset_id,
                   (1 - (ae.vector <=> %s::vector))::real as similarity
            from public.media_assets a
            join public.asset_embeddings ae
              on ae.asset_id = a.id
             and ae.space_id = %s
             and ae.kind = 'global'
            where a.id <> %s and a.deleted_at is null and a.review_state <> 'rejected'
              and ae.vector is not null
              and 1 - (ae.vector <=> %s::vector) >= %s
            order by ae.vector <=> %s::vector
            limit least(greatest(%s, 1), 50)
            """,
            (
                _vector(embedding),
                active_space,
                media_asset_id,
                _vector(embedding),
                effective_threshold,
                _vector(embedding),
                match_count,
            ),
        )

    def match_phash_duplicate_candidates(self, media_asset_id: str, phash: str, max_distance: int, match_count: int = 10) -> list[dict[str, Any]]:
        try:
            valid_distance = 0 <= int(max_distance) <= 32
        except (TypeError, ValueError):
            valid_distance = False
        if not isinstance(phash, str) or not re.fullmatch(r"[0-9a-f]{16}", phash) or not valid_distance:
            raise GatewayError("Invalid pHash query")
        return self._fetch_all(
            """
            with candidates as (
                select a.id,
                       length(replace(((('x' || a.phash)::bit(64)) # (('x' || %s)::bit(64)))::text, '0', ''))::integer as distance
                from public.media_assets a
                where a.id <> %s and a.deleted_at is null and a.review_state <> 'rejected' and a.phash ~ '^[0-9a-f]{16}$'
            )
            select id as candidate_media_asset_id, distance as hamming_distance,
                   (1 - distance::real / 64)::real as similarity
            from candidates where distance <= %s order by distance asc, id
            limit least(greatest(%s, 1), 50)
            """,
            (phash, media_asset_id, int(max_distance), match_count),
        )

    def get_sku_references(self, sku: str, space_id: str | None = None) -> list[dict[str, Any]]:
        target_space = space_id or self.space_resolver.get_active_space_id()
        return self._fetch_all(
            """
            select re.vector::text as embedding, r.source_url, r.is_primary, r.is_frozen_benchmark, r.reference_role
            from public.reference_embeddings re
            join public.sku_references r on r.reference_id = re.reference_id
            where re.space_id = %s
              and r.sku in (
                select %s::text
                union
                select unnest(p.aliases) from public.verity_products p where p.primary_sku = %s
                union
                select p.primary_sku from public.verity_products p where %s = any(p.aliases)
              )
              and r.is_active = true and r.match_eligible = true
            """,
            (target_space, sku, sku, sku),
        )

    def get_catalog_product(self, sku: str) -> dict[str, Any] | None:
        """Return the catalog identity attached to a recognized SKU.

        SKU matching and open-ended Vision metadata are intentionally separate
        signals.  Once the SKU has passed the embedding gates, the catalog is
        the authoritative source for the product's brand/model fields; this
        prevents a blank Vision brand from erasing a known catalog brand.
        """

        return self._fetch_one(
            """
            select id, primary_sku, code, display_name, brand, model_name, catalog_sku_kind
            from public.verity_products
            where lower(primary_sku) = lower(%s)
               or lower(code) = lower(%s)
               or %s = any(aliases)
               or exists (
                 select 1 from unnest(aliases) a where lower(trim(a)) = lower(%s)
               )
            order by (source_system in ('woocommerce', 'backfill')) desc,
                     (lower(primary_sku) = lower(%s)) desc,
                     updated_at desc
            limit 1
            """,
            (sku, sku, sku, sku, sku),
        )

    def list_existing_production_reference_pairs(self) -> set[tuple[str, str]]:
        rows = self._fetch_all(
            """
            select sku, source_url from public.sku_reference_embeddings
            where embedding_provider = %s and embedding_model = %s
              and embedding_version = %s and embedding_dimension = %s
              and source_kind = 'catalog' and is_active
            """,
            (_PROVIDER, PRODUCTION_EMBEDDING_MODEL, PRODUCTION_EMBEDDING_VERSION, _DIMENSION),
        )
        return {(row.get("sku", ""), row.get("source_url", "")) for row in rows if row.get("sku") and row.get("source_url")}

    def upsert_catalog_product(
        self,
        sku: str,
        display_name: str,
        brand: str | None = None,
        model_name: str | None = None,
        catalog_sku_kind: str = "unknown",
    ) -> Any:
        """Upsert the catalog identity before its production references.

        The catalog importer is allowed to enrich an existing draft product,
        but it must not replace a non-unknown brand that was already confirmed
        by a human or a Product-DB sync.
        """

        if self.settings.embedding_profile not in {PRODUCTION_EMBEDDING_PROFILE, "local_openclip", "production_api", "legacy_api"}:
            raise GatewayError("Only authorized production profile may write catalog products")
        sku_value = _text(sku)
        if not sku_value:
            raise GatewayError("Catalog product SKU is required")
        display_value = _text(display_name) or sku_value
        brand_value = _text(brand) or "unknown"
        model_value = _text(model_name) or None
        kind_value = catalog_sku_kind if catalog_sku_kind in {"machine_code", "model_name", "missing", "unknown"} else "unknown"
        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    """
                    select id
                    from public.verity_products
                    where lower(primary_sku) = lower(%s)
                       or lower(code) = lower(%s)
                       or (source_system = 'woocommerce' and external_id = %s)
                    order by (lifecycle = 'active') desc, created_at asc
                    limit 1
                    """,
                    (sku_value, sku_value, sku_value),
                )
                row = cursor.fetchone()
                if row:
                    product_id = row[0]
                    cursor.execute(
                        """
                        update public.verity_products
                        set display_name = case
                              when lifecycle = 'draft'
                                or nullif(trim(display_name), '') is null
                                or lower(trim(display_name)) in (lower(trim(primary_sku)), lower(trim(code)))
                                then case when %s <> '' then %s else display_name end
                              else display_name
                            end,
                            brand = case
                              when (%s = '' or lower(coalesce(brand, 'unknown')) = 'unknown')
                                and %s <> 'unknown' then %s
                              else coalesce(nullif(trim(brand), ''), 'unknown')
                            end,
                            model_name = case
                              when lifecycle = 'draft' or nullif(trim(model_name), '') is null
                                then coalesce(nullif(%s, ''), model_name)
                              else model_name
                            end,
                            catalog_sku_kind = case
                              when catalog_sku_kind = 'unknown' or lifecycle = 'draft' then %s
                              else catalog_sku_kind
                            end,
                            primary_sku = coalesce(nullif(primary_sku, ''), %s),
                            updated_at = now()
                        where id = %s
                        """,
                        (
                            display_value,
                            display_value,
                            brand_value,
                            brand_value,
                            brand_value,
                            model_value or "",
                            kind_value,
                            sku_value,
                            product_id,
                        ),
                    )
                    return product_id

                cursor.execute(
                    """
                    insert into public.verity_products
                      (code, display_name, brand, model_name, catalog_sku_kind, primary_sku,
                       lifecycle, source_system, external_id)
                    values (%s, %s, %s, %s, %s, %s, 'draft', 'woocommerce', %s)
                    on conflict (code) do update set
                      display_name = excluded.display_name,
                      brand = case
                        when lower(coalesce(public.verity_products.brand, 'unknown')) = 'unknown'
                         and excluded.brand <> 'unknown' then excluded.brand
                        else public.verity_products.brand
                      end,
                      model_name = coalesce(excluded.model_name, public.verity_products.model_name),
                      catalog_sku_kind = case
                        when public.verity_products.catalog_sku_kind = 'unknown' then excluded.catalog_sku_kind
                        else public.verity_products.catalog_sku_kind
                      end,
                      primary_sku = coalesce(nullif(public.verity_products.primary_sku, ''), excluded.primary_sku),
                      updated_at = now()
                    returning id
                    """,
                    (sku_value, display_value, brand_value, model_value, kind_value, sku_value, sku_value),
                )
                inserted = cursor.fetchone()
                return inserted[0] if inserted else None
        except Exception as error:
            raise GatewayError(f"Could not upsert catalog product: {type(error).__name__}: {error}") from error

    def ensure_catalog_reference_primary(self, sku: str) -> None:
        """Keep one deterministic primary reference for a production SKU."""

        if self.settings.embedding_profile not in {PRODUCTION_EMBEDDING_PROFILE, "local_openclip", "production_api", "legacy_api"}:
            raise GatewayError("Only authorized production profile may repair catalog references")
        sku_value = _text(sku)
        if not sku_value:
            raise GatewayError("Catalog reference SKU is required")
        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    """
                    with chosen as (
                      select id
                      from public.sku_reference_embeddings
                      where sku = %s and is_active
                        and embedding_provider = %s
                        and embedding_model = %s
                        and embedding_version = %s
                        and embedding_dimension = %s
                      order by is_primary desc, created_at asc, id
                      limit 1
                    )
                    update public.sku_reference_embeddings r
                    set is_primary = (r.id = (select id from chosen))
                    where r.sku = %s and r.is_active
                      and r.embedding_provider = %s
                      and r.embedding_model = %s
                      and r.embedding_version = %s
                      and r.embedding_dimension = %s
                    """,
                    (
                        sku_value,
                        _PROVIDER,
                        PRODUCTION_EMBEDDING_MODEL,
                        PRODUCTION_EMBEDDING_VERSION,
                        _DIMENSION,
                        sku_value,
                        _PROVIDER,
                        PRODUCTION_EMBEDDING_MODEL,
                        PRODUCTION_EMBEDDING_VERSION,
                        _DIMENSION,
                    ),
                )
                # The canonical matcher reads sku_references, not the legacy
                # sku_reference_embeddings table above. Repair both stores so
                # a legacy seeding run cannot leave the production matcher
                # without a primary anchor.
                cursor.execute(
                    """
                    with chosen as (
                      select reference_id
                      from public.sku_references
                      where sku = %s and is_active and match_eligible
                      order by is_primary desc,
                               (reference_role = 'HERO') desc,
                               (curation_status = 'REVIEWED') desc,
                               quality_score desc nulls last,
                               created_at asc,
                               reference_id asc
                      limit 1
                    )
                    update public.sku_references r
                    set is_primary = (r.reference_id = (select reference_id from chosen)),
                        updated_at = now()
                    where r.sku = %s and r.is_active and r.match_eligible
                    """,
                    (sku_value, sku_value),
                )
        except Exception as error:
            raise GatewayError(f"Could not repair catalog reference primary: {type(error).__name__}: {error}") from error

    def insert_catalog_reference(self, sku: str, source_url: str, embedding: list[float], is_primary: bool) -> None:
        if self.settings.embedding_profile not in {PRODUCTION_EMBEDDING_PROFILE, "local_openclip", "production_api", "legacy_api"}:
            raise GatewayError("Only authorized production profile may write production references")
        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    """
                    update public.sku_reference_embeddings
                    set embedding = %s::vector,
                        is_active = true,
                        is_primary = %s
                    where sku = %s and source_url = %s and source_kind = 'catalog'
                      and embedding_provider = %s
                      and embedding_model = %s
                      and embedding_version = %s
                      and embedding_dimension = %s
                    """,
                    (
                        _vector(embedding),
                        is_primary,
                        sku,
                        source_url,
                        _PROVIDER,
                        PRODUCTION_EMBEDDING_MODEL,
                        PRODUCTION_EMBEDDING_VERSION,
                        _DIMENSION,
                    ),
                )
                if getattr(cursor, "rowcount", 0) > 0:
                    return
                cursor.execute(
                    """
                    insert into public.sku_reference_embeddings
                      (sku, product_id, source_url, embedding, source_kind, is_primary, is_active,
                       embedding_provider, embedding_model, embedding_version, embedding_dimension)
                    values (
                      %s,
                      (select id from public.verity_products
                       where lower(primary_sku) = lower(%s) or lower(code) = lower(%s)
                       order by (lifecycle = 'active') desc, created_at asc limit 1),
                      %s, %s::vector, 'catalog', %s, true, %s, %s, %s, %s
                    )
                    on conflict do nothing
                    """,
                    (sku, sku, sku, source_url, _vector(embedding), is_primary, _PROVIDER,
                     PRODUCTION_EMBEDDING_MODEL, PRODUCTION_EMBEDDING_VERSION, _DIMENSION),
                )
        except Exception as error:
            raise GatewayError(f"Could not insert production reference: {type(error).__name__}: {error}") from error

    def list_assets_outside_embedding_space(self, space_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        target_space = space_id or self.space_resolver.get_active_space_id()
        return self._fetch_all(
            """
            select a.id, a.storage_path, a.embedding_provider, a.embedding_model,
                   a.embedding_version, a.embedding_dimension
            from public.media_assets a
            where a.deleted_at is null
              and not exists (
                select 1 from public.asset_embeddings ae
                where ae.asset_id = a.id and ae.space_id = %s and ae.kind = 'global'
              )
            order by a.created_at asc limit %s
            """,
            (target_space, max(1, min(limit, 2000))),
        )

    def get_asset_embedding(self, media_asset_id: str, space_id: str | None = None) -> str | None:
        target_space = space_id or self.space_resolver.get_active_space_id()
        row = self._fetch_one(
            """
            select ae.vector::text as vector
            from public.asset_embeddings ae
            join public.media_assets a on a.id = ae.asset_id
            where ae.asset_id = %s and ae.space_id = %s and ae.kind = 'global' and a.deleted_at is null
            limit 1
            """,
            (media_asset_id, target_space),
        )
        if row is None:
            asset_exists = self._fetch_one(
                "select 1 from public.media_assets where id = %s and deleted_at is null limit 1",
                (media_asset_id,),
            )
            if asset_exists is None:
                raise GatewayError(f"Media asset {media_asset_id} no longer exists")
            return None
        value = row.get("vector")
        return value if isinstance(value, str) else None

    def update_asset_embedding(
        self,
        media_asset_id: str,
        embedding: list[float] | dict[str, list[float]],
        space_id: str | None = None,
    ) -> None:
        if self.settings.embedding_profile not in {PRODUCTION_EMBEDDING_PROFILE, "local_openclip", "production_api", "legacy_api"}:
            raise GatewayError("Only authorized production profile may write production asset embeddings")
        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    "select id from public.media_assets where id = %s and deleted_at is null for update",
                    (media_asset_id,),
                )
                if cursor.fetchone() is None:
                    raise GatewayError(f"Media asset {media_asset_id} no longer exists")

                if isinstance(embedding, dict):
                    embeddings_map = embedding
                elif space_id:
                    embeddings_map = {space_id: embedding}
                else:
                    active_space = self.space_resolver.get_active_space_id()
                    embeddings_map = {active_space: embedding}

                for s_id, vec in embeddings_map.items():
                    cursor.execute(
                        """
                        insert into public.asset_embeddings (asset_id, space_id, kind, vector)
                        values (%s, %s, 'global', %s::vector)
                        on conflict (asset_id, space_id) where kind = 'global'
                        do update set vector = excluded.vector, created_at = now()
                        """,
                        (media_asset_id, s_id, _vector(vec)),
                    )

                if _LEGACY_DATACOMP_SPACE_ID in embeddings_map:
                    datacomp_vec = embeddings_map[_LEGACY_DATACOMP_SPACE_ID]
                    if len(datacomp_vec) != _DIMENSION:
                        raise GatewayError(
                            f"update_asset_embedding: DataComp legacy column requires exactly "
                            f"{_DIMENSION} dimensions, got {len(datacomp_vec)}. "
                            f"Do not pass a {len(datacomp_vec)}-d vector under {_LEGACY_DATACOMP_SPACE_ID}."
                        )
                    cursor.execute(
                        """
                        update public.media_assets
                        set image_embedding = %s::vector, embedding_provider = %s,
                            embedding_model = %s, embedding_version = %s, embedding_dimension = %s
                        where id = %s and deleted_at is null
                        """,
                        (_vector(datacomp_vec), _PROVIDER, "openclip-b32-datacomp-256",
                         "v1", _DIMENSION, media_asset_id),
                    )
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"Could not update production embedding: {type(error).__name__}: {error}") from error

    def _complete_media_analysis(self, payload: dict[str, Any]) -> None:
        """Persist an analysis result atomically.

        The SQL mirrors the production RPC but intentionally does not rely on
        database role context.
        """

        job_id = payload.get("p_job_id")
        phash = payload.get("p_phash")
        if not _valid_uuid(job_id) or not isinstance(phash, str) or not re.fullmatch(r"[0-9a-f]{16}", phash):
            raise GatewayError("Invalid analysis completion payload")
        metadata = payload.get("p_metadata_draft") if isinstance(payload.get("p_metadata_draft"), dict) else {}
        embeddings_by_space: dict[str, list[float]] = {}
        raw_embeddings_map = payload.get("p_embeddings_by_space")
        if isinstance(raw_embeddings_map, dict):
            for s_id, v in raw_embeddings_map.items():
                if isinstance(v, str):
                    try:
                        v = [float(x) for x in v.strip("[]").split(",") if x.strip()]
                    except ValueError:
                        continue
                if isinstance(v, (list, tuple)) and all(isinstance(x, (int, float)) and math.isfinite(float(x)) for x in v):
                    embeddings_by_space[s_id] = list(v)

        raw_embedding = payload.get("p_image_embedding")
        if isinstance(raw_embedding, str):
            try:
                raw_embedding = [float(value) for value in raw_embedding.strip("[]").split(",") if value.strip()]
            except ValueError as error:
                raise GatewayError("Production image embedding is not numeric") from error
        if isinstance(raw_embedding, (list, tuple)):
            if len(raw_embedding) == _DIMENSION and all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in raw_embedding):
                if _LEGACY_DATACOMP_SPACE_ID not in embeddings_by_space:
                    embeddings_by_space[_LEGACY_DATACOMP_SPACE_ID] = list(raw_embedding)
            elif any(not isinstance(value, (int, float)) or not math.isfinite(float(value)) for value in raw_embedding):
                raise GatewayError("Production image embedding must contain finite numeric values")

        active_space = self.space_resolver.get_active_space_id()
        if not embeddings_by_space and raw_embedding is not None and isinstance(raw_embedding, (list, tuple)):
            embeddings_by_space[active_space] = list(raw_embedding)

        if not embeddings_by_space:
            raise GatewayError("Production image embedding must contain finite numeric values")
        sku_match = payload.get("p_sku_match") if isinstance(payload.get("p_sku_match"), dict) else {}
        raw_phash_matches = payload.get("p_phash_matches") if isinstance(payload.get("p_phash_matches"), list) else []
        raw_scene_matches = payload.get("p_scene_matches") if isinstance(payload.get("p_scene_matches"), list) else []
        phash_matches: list[dict[str, Any]] = []
        scene_matches: list[dict[str, Any]] = []
        valid_duplicates: list[dict[str, Any]] = []
        duplicate_ids: list[str] = []
        duplicate_similarity = 0.0
        has_people = bool(metadata.get("has_people"))
        confidence = {
            "sku": round(float(sku_match.get("similarity", 0) or 0) * 100),
            "brand": round(float(metadata.get("brand_confidence", 0) or 0) * 100),
            "category": round(float(metadata.get("category_confidence", 0) or 0) * 100),
            "space": round(float(metadata.get("space_confidence", 0) or 0) * 100),
        }
        width = int(payload.get("p_width") or 0)
        height = int(payload.get("p_height") or 0)
        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    "select j.media_asset_id, a.content_hash from public.media_ingest_jobs j join public.media_assets a on a.id = j.media_asset_id where j.id = %s and j.job_kind = 'analyze_image' and j.status = 'processing' and a.deleted_at is null for update",
                    (job_id,),
                )
                row = cursor.fetchone()
                if not row:
                    raise GatewayError("Analysis job is not leased")
                asset_id = row[0] if not isinstance(row, Mapping) else row.get("media_asset_id")
                content_hash = row[1] if (not isinstance(row, Mapping) and len(row) > 1) else (row.get("content_hash") if isinstance(row, Mapping) else None)

                candidate_ids = sorted({
                    str(uuid.UUID(str(item["candidate_media_asset_id"])))
                    for item in raw_phash_matches + raw_scene_matches
                    if isinstance(item, dict) and _valid_uuid(item.get("candidate_media_asset_id"))
                })
                active_candidate_ids: set[str] = set()
                if candidate_ids:
                    cursor.execute(
                        """
                        select id
                        from public.media_assets
                        where id = any(%s::uuid[])
                          and deleted_at is null
                          and review_state <> 'rejected'
                        """,
                        (candidate_ids,),
                    )
                    active_rows = cursor.fetchall()
                    for candidate_row in active_rows:
                        candidate_id = (
                            candidate_row.get("id")
                            if isinstance(candidate_row, Mapping)
                            else candidate_row[0]
                        )
                        if candidate_id is not None:
                            active_candidate_ids.add(str(candidate_id))
                phash_matches = _active_duplicate_matches(raw_phash_matches, active_candidate_ids)
                scene_matches = _active_duplicate_matches(raw_scene_matches, active_candidate_ids)
                valid_duplicates = phash_matches + scene_matches
                duplicate_ids = sorted({str(uuid.UUID(str(item["candidate_media_asset_id"]))) for item in valid_duplicates})
                duplicate_similarity = max(
                    [float(item["similarity"]) for item in valid_duplicates if isinstance(item.get("similarity"), (int, float))],
                    default=0.0,
                )
                candidate_legacy = embeddings_by_space.get(_LEGACY_DATACOMP_SPACE_ID)
                if candidate_legacy is None and raw_embedding is not None and isinstance(raw_embedding, (list, tuple)) and len(raw_embedding) == _DIMENSION:
                    candidate_legacy = raw_embedding
                legacy_vector = candidate_legacy if (candidate_legacy and len(candidate_legacy) == _DIMENSION) else None
                ai_keywords = (
                    [str(k).strip() for k in metadata.get("keywords", []) if isinstance(k, str) and str(k).strip()]
                    if isinstance(metadata.get("keywords"), list)
                    else None
                )
                if not ai_keywords:
                    ai_keywords = None
                ai_visible_text = (
                    [str(v).strip() for v in metadata.get("visible_text", []) if isinstance(v, str) and str(v).strip()]
                    if isinstance(metadata.get("visible_text"), list)
                    else None
                )
                cursor.execute(
                    """
                    update public.media_assets
                    set phash = %s,
                        image_embedding = coalesce(%s::vector, image_embedding),
                        embedding_provider = coalesce(%s, embedding_provider),
                        embedding_model = coalesce(%s, embedding_model),
                        embedding_version = coalesce(%s, embedding_version),
                        embedding_dimension = coalesce(%s::int, embedding_dimension),
                        -- Keep model candidates in review evidence while a
                        -- product-intake reviewer owns the identity.  This
                        -- avoids creating an auto_sku catalog draft.
                        sku = case when exists (
                              select 1
                              from public.product_intake_assets pia
                              join public.product_intakes pi on pi.id = pia.intake_id
                              where pia.media_asset_id = public.media_assets.id
                                and pi.status in ('draft', 'submitted', 'needs_changes', 'approved', 'rejected')
                            ) then sku
                            when nullif(trim(public.media_assets.sku), '') is not null then public.media_assets.sku
                            else nullif(trim(%s), '') end,
                        brand = coalesce(nullif(trim(%s), ''), brand),
                        category = coalesce(nullif(trim(%s), ''), category),
                        space = nullif(trim(%s), ''), status = coalesce(nullif(trim(%s), ''), status),
                        suggested_caption = coalesce(nullif(trim(%s), ''), suggested_caption),
                        description = coalesce(nullif(trim(%s), ''), description),
                        keywords = case when coalesce(array_length(keywords, 1), 0) = 0
                                        then coalesce(%s::text[], keywords)
                                        else keywords end,
                        visible_text = coalesce(%s::text[], visible_text),
                        thumbnail_path = coalesce(nullif(trim(%s), ''), thumbnail_path),
                        thumbnail_url = coalesce(nullif(trim(%s), ''), thumbnail_url),
                        dimensions = case
                            when %s::int > 0 and %s::int > 0
                            then coalesce(dimensions, '{}'::jsonb) || jsonb_build_object('width', %s::int, 'height', %s::int)
                            else dimensions
                        end,
                        ai_flags = coalesce(ai_flags, '{}'::jsonb) || jsonb_build_object('has_people', %s::boolean, 'shot_type', %s::text),
                        ai_confidence = coalesce(ai_confidence, '{}'::jsonb) || %s::jsonb,
                        -- CRITICAL: In PostgreSQL, '' IS NOT NULL evaluates to TRUE.
                        -- Both SQL nullif(trim(...), '') and Python _nullable_text must be used
                        -- to ensure that a successful upload with no error (None or "") sets ingest_status = 'ready'.
                        ingest_status = case when nullif(trim(%s), '') is not null then 'failed' else 'ready' end,
                        ingest_error = nullif(trim(%s), ''),
                        ingested_at = case when nullif(trim(%s), '') is not null then ingested_at else now() end
                    where id = %s and deleted_at is null
                    """,
                    (phash,
                     _vector(legacy_vector) if legacy_vector else None,
                     _PROVIDER if legacy_vector else None,
                     "openclip-b32-datacomp-256" if legacy_vector else None,
                     "v1" if legacy_vector else None,
                     len(legacy_vector) if legacy_vector else None,
                     _text(payload.get("p_sku_suggestion")),
                     _text(metadata.get("brand")), _text(metadata.get("category")), _text(metadata.get("space")),
                     _text(metadata.get("status")), _text(metadata.get("caption")), _text(metadata.get("description")),
                     ai_keywords,
                     ai_visible_text,
                     _text(payload.get("p_thumbnail_path")), _text(payload.get("p_thumbnail_url")),
                     width, height, width, height,
                     has_people, _text(metadata.get("shot_type")), _json(confidence),
                     _nullable_text(payload.get("p_metadata_error")),
                     _nullable_text(payload.get("p_metadata_error")),
                     _nullable_text(payload.get("p_metadata_error")),
                     asset_id),
                )
                for s_id, vec in embeddings_by_space.items():
                    cursor.execute(
                        """
                        insert into public.asset_embeddings (asset_id, space_id, kind, vector, source_sha256)
                        values (%s, %s, 'global', %s::vector, %s)
                        on conflict (asset_id, space_id) where kind = 'global'
                        do update set vector = excluded.vector, source_sha256 = excluded.source_sha256, created_at = now()
                        """,
                        (asset_id, s_id, _vector(vec), content_hash),
                    )
                metadata_with_error = {**metadata, "error": payload.get("p_metadata_error")}
                cursor.execute(
                    """
                    update public.review_queue q
                    set sku_match = %s::jsonb, metadata_draft = %s::jsonb,
                        dedup_summary = %s::jsonb, is_duplicate = %s, duplicate_similarity = %s,
                        duplicate_asset_ids = %s::jsonb
                    where q.media_asset_id = %s and q.status = 'pending'
                      and exists (select 1 from public.media_assets a where a.id = q.media_asset_id and a.deleted_at is null)
                    """,
                    (_json(sku_match), _json(metadata_with_error), _json({"phash": phash_matches, "scene_embedding": scene_matches}),
                     bool(valid_duplicates), duplicate_similarity, _json(duplicate_ids), asset_id),
                )
                for item in phash_matches:
                    self._insert_dedup(cursor, asset_id, item, "phash")
                for item in scene_matches:
                    self._insert_dedup(cursor, asset_id, item, "scene_embedding")
                cursor.execute(
                    "insert into public.media_tagging_runs (media_asset_id, job_id, tagger, status, model, output) values (%s, %s, 'sku_clip', 'succeeded', %s, %s::jsonb)",
                    (asset_id, job_id, payload.get("p_sku_model"), _json(sku_match)),
                )
                cursor.execute(
                    "insert into public.media_tagging_runs (media_asset_id, job_id, tagger, status, model, prompt_version, output, error_message) values (%s, %s, 'metadata_vision', %s, %s, %s, %s::jsonb, %s)",
                    (asset_id, job_id, "failed" if payload.get("p_metadata_error") else "succeeded",
                     payload.get("p_metadata_model"), payload.get("p_prompt_version"), _json(metadata), payload.get("p_metadata_error")),
                )
                job_status = "failed" if payload.get("p_metadata_error") else "succeeded"
                cursor.execute(
                    "update public.media_ingest_jobs set status = %s, error_message = %s, result = %s::jsonb, locked_at = null, locked_by = null, completed_at = now(), updated_at = now() where id = %s",
                    (job_status, _text(payload.get("p_metadata_error")), _json({"media_asset_id": str(asset_id)}), job_id),
                )
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"Could not complete analysis: {type(error).__name__}: {error}") from error

    def _complete_product_intake_reference(self, payload: dict[str, Any]) -> None:
        """Activate one reviewer-selected product reference only after proving
        that the active-space vector came from the immutable source bytes."""
        job_id = payload.get("p_job_id")
        source_sha256 = _text(payload.get("p_source_sha256")).lower()
        if not _valid_uuid(job_id):
            raise GatewayError("Invalid product-intake reference job id")
        if not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
            raise GatewayError("Product-intake reference source SHA-256 is invalid")

        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    """
                    select j.media_asset_id, j.payload->>'product_intake_id' as product_intake_id
                    from public.media_ingest_jobs j
                    where j.id = %s and j.job_kind = 'prepare_reference' and j.status = 'processing'
                    for update
                    """,
                    (job_id,),
                )
                job = _dict_row(cursor.fetchone(), ("media_asset_id", "product_intake_id"))
                if not job or not _valid_uuid(job.get("product_intake_id")):
                    raise GatewayError("Product-intake reference job is not leased")
                asset_id = str(job["media_asset_id"])
                intake_id = str(job["product_intake_id"])

                cursor.execute(
                    """
                    select pi.status, pi.final_sku, pia.decision, pia.is_reference,
                           pia.confirmed_role, pia.confirmed_image_category,
                           a.review_state, a.ingest_status, a.deleted_at, a.content_hash
                    from public.product_intakes pi
                    join public.product_intake_assets pia on pia.intake_id = pi.id
                    join public.media_assets a on a.id = pia.media_asset_id
                    where pi.id = %s and pia.media_asset_id = %s
                    for update of pi, pia, a
                    """,
                    (intake_id, asset_id),
                )
                state = _dict_row(
                    cursor.fetchone(),
                    ("status", "final_sku", "decision", "is_reference", "confirmed_role", "confirmed_image_category",
                     "review_state", "ingest_status", "deleted_at", "content_hash"),
                )
                if not state:
                    raise GatewayError("Product-intake reference source no longer belongs to its intake")
                if (
                    state.get("status") != "approved"
                    or state.get("decision") != "approved"
                    or state.get("is_reference") is not True
                    or state.get("review_state") != "approved"
                    or state.get("ingest_status") != "ready"
                    or state.get("deleted_at") is not None
                ):
                    raise GatewayError("Product-intake reference is no longer eligible")
                sku = _text(state.get("final_sku"))
                if not sku:
                    raise GatewayError("Approved product intake does not have a final SKU")
                content_hash = _text(state.get("content_hash")).lower()
                if content_hash and content_hash != source_sha256:
                    raise GatewayError("Product-intake reference source changed after analysis")
                if not content_hash:
                    cursor.execute(
                        "update public.media_assets set content_hash = %s, updated_at = now() where id = %s",
                        (source_sha256, asset_id),
                    )

                # Deliberately bypass SpaceResolver: fallback defaults must
                # never make a product appear reference-ready after a DB error.
                cursor.execute(
                    """
                    select ers.active_space_id
                    from public.embedding_runtime_state ers
                    join public.embedding_spaces es on es.space_id = ers.active_space_id
                    where ers.singleton_id = 1 and es.status = 'ACTIVE'
                    for share
                    """
                )
                active_row = _dict_row(cursor.fetchone(), ("active_space_id",))
                active_space_id = _text(active_row.get("active_space_id") if active_row else None)
                if not active_space_id:
                    raise GatewayError("No active embedding space is configured for product references")
                cursor.execute(
                    """
                    select ae.source_sha256
                    from public.asset_embeddings ae
                    where ae.asset_id = %s and ae.space_id = %s and ae.kind = 'global' and ae.vector is not null
                    for share
                    """,
                    (asset_id, active_space_id),
                )
                embedding_row = _dict_row(cursor.fetchone(), ("source_sha256",))
                if not embedding_row or _text(embedding_row.get("source_sha256")).lower() != source_sha256:
                    raise GatewayError("Active asset embedding is missing or does not match the reference source")

                cursor.execute("select pg_advisory_xact_lock(hashtextextended(lower(%s), 0))", (sku,))
                cursor.execute(
                    """
                    select exists(
                      select 1 from public.sku_references
                       where sku = %s and is_active = true and match_eligible = true and is_primary = true
                         and source_media_asset_id is distinct from %s
                    ) as has_primary
                    """,
                    (sku, asset_id),
                )
                primary_row = _dict_row(cursor.fetchone(), ("has_primary",))
                has_primary = bool(primary_row and primary_row.get("has_primary"))
                # Prefer the reviewer-confirmed labels the intake carries; fall
                # back to the DB-state heuristic (HERO for the first reference of
                # a SKU, ANGLE afterwards) and the historical STUDIO default so
                # older intakes without labels still promote correctly.
                confirmed_role = _text(state.get("confirmed_role")).upper()
                role = confirmed_role if confirmed_role in ("HERO", "ANGLE") else ("ANGLE" if has_primary else "HERO")
                confirmed_category = _text(state.get("confirmed_image_category")).upper()
                image_category = confirmed_category if confirmed_category in ("REAL", "STUDIO", "DESIGN") else "STUDIO"
                cursor.execute(
                    """
                    insert into public.sku_references
                      (sku, source_media_asset_id, verified, reference_role, image_category,
                       curation_status, is_active, match_eligible, is_primary, created_by)
                    values (%s, %s, true, %s, %s, 'VERIFIED', true, false, false, null)
                    on conflict (sku, source_media_asset_id) where source_media_asset_id is not null
                    do update set verified = true, reference_role = excluded.reference_role,
                                  image_category = excluded.image_category, curation_status = excluded.curation_status,
                                  is_active = true, match_eligible = false, updated_at = now()
                    returning reference_id
                    """,
                    (sku, asset_id, role, image_category),
                )
                reference_row = _dict_row(cursor.fetchone(), ("reference_id",))
                if not reference_row:
                    raise GatewayError("Could not create canonical product reference")
                reference_id = str(reference_row["reference_id"])
                cursor.execute(
                    """
                    insert into public.reference_embeddings (reference_id, space_id, vector, source_sha256)
                    select %s, ae.space_id, ae.vector, ae.source_sha256
                    from public.asset_embeddings ae
                    where ae.asset_id = %s and ae.space_id = %s and ae.kind = 'global'
                      and ae.source_sha256 = %s and ae.vector is not null
                    on conflict (reference_id, space_id)
                    do update set vector = excluded.vector, source_sha256 = excluded.source_sha256,
                                  created_at = now()
                    """,
                    (reference_id, asset_id, active_space_id, source_sha256),
                )
                if cursor.rowcount != 1:
                    raise GatewayError("Cannot materialize reference embedding in the active space")
                cursor.execute(
                    """
                    update public.sku_references
                       set match_eligible = true,
                           is_primary = case when %s then false else true end,
                           updated_at = now()
                     where reference_id = %s
                    """,
                    (has_primary, reference_id),
                )
                cursor.execute(
                    """
                    update public.product_intakes
                       set reference_status = 'ready', reference_error = null,
                           reference_updated_at = now(), updated_at = now()
                     where id = %s and status = 'approved'
                    """,
                    (intake_id,),
                )
                cursor.execute(
                    """
                    update public.media_ingest_jobs
                       set status = 'succeeded', result = %s::jsonb, locked_at = null, locked_by = null,
                           completed_at = now(), updated_at = now()
                     where id = %s and status = 'processing'
                    """,
                    (_json({"reference_id": reference_id, "space_id": active_space_id, "source_sha256": source_sha256}), job_id),
                )
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"Could not prepare product-intake reference: {type(error).__name__}: {error}") from error

    def _complete_video_analysis(self, payload: dict[str, Any]) -> None:
        """Persist video analysis result atomically.

        Sets thumbnail_path, thumbnail_url, duration, dimensions,
        and marks ingest_status = 'ready'.
        """
        job_id = payload.get("p_job_id")
        if not _valid_uuid(job_id):
            raise GatewayError("Invalid video analysis completion payload: invalid job_id")

        thumbnail_path = _text(payload.get("p_thumbnail_path"))
        thumbnail_url = _text(payload.get("p_thumbnail_url"))
        duration = _text(payload.get("p_duration"))
        width = int(payload.get("p_width") or 0)
        height = int(payload.get("p_height") or 0)
        metadata_error = payload.get("p_metadata_error")

        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    "select j.media_asset_id from public.media_ingest_jobs j join public.media_assets a on a.id = j.media_asset_id where j.id = %s and j.job_kind = 'analyze_image' and j.status = 'processing' and a.deleted_at is null for update",
                    (job_id,),
                )
                row = cursor.fetchone()
                if not row:
                    raise GatewayError("Analysis job is not leased")
                asset_id = row[0] if not isinstance(row, Mapping) else row.get("media_asset_id")

                cursor.execute(
                    """
                    update public.media_assets
                    set thumbnail_path = coalesce(%s, thumbnail_path),
                        thumbnail_url = coalesce(%s, thumbnail_url),
                        duration = nullif(trim(%s), ''),
                        dimensions = case
                            when %s::int > 0 and %s::int > 0
                            then coalesce(dimensions, '{}'::jsonb) || jsonb_build_object('width', %s::int, 'height', %s::int)
                            else dimensions
                        end,
                        ingest_status = 'ready', ingest_error = nullif(trim(%s), ''), ingested_at = now()
                    where id = %s and deleted_at is null
                    """,
                    (thumbnail_path, thumbnail_url, duration, width, height, width, height, _nullable_text(metadata_error), asset_id),
                )

                metadata_draft = {
                    "category": "Video",
                    "duration": duration,
                }
                if metadata_error:
                    metadata_draft["error"] = metadata_error

                cursor.execute(
                    """
                    update public.review_queue q
                    set metadata_draft = %s::jsonb,
                        is_duplicate = false,
                        duplicate_similarity = 0,
                        duplicate_asset_ids = '[]'::jsonb
                    where q.media_asset_id = %s and q.status = 'pending'
                      and exists (select 1 from public.media_assets a where a.id = q.media_asset_id and a.deleted_at is null)
                    """,
                    (_json(metadata_draft), asset_id),
                )

                cursor.execute(
                    "update public.media_ingest_jobs set status = 'succeeded', result = %s::jsonb, locked_at = null, locked_by = null, completed_at = now(), updated_at = now() where id = %s",
                    (_json({"media_asset_id": str(asset_id), "type": "video"}), job_id),
                )
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"Could not complete video analysis: {type(error).__name__}: {error}") from error

    @staticmethod
    def _insert_dedup(cursor: Any, asset_id: Any, item: Any, method: str) -> None:
        if not isinstance(item, dict) or not _valid_uuid(item.get("candidate_media_asset_id")):
            return
        similarity = item.get("similarity") if isinstance(item.get("similarity"), (int, float)) else None
        distance = item.get("hamming_distance") if isinstance(item.get("hamming_distance"), int) else None
        cursor.execute(
            """
            insert into public.media_dedup_matches
              (media_asset_id, candidate_media_asset_id, method, similarity, hamming_distance, threshold)
            select %s, %s, %s, %s, %s, %s::jsonb
            where exists (select 1 from public.media_assets source where source.id = %s and source.deleted_at is null)
              and exists (
                select 1
                from public.media_assets candidate
                where candidate.id = %s
                  and candidate.deleted_at is null
                  and candidate.review_state <> 'rejected'
              )
            on conflict (media_asset_id, candidate_media_asset_id, method) do update
              set similarity = excluded.similarity, hamming_distance = excluded.hamming_distance,
                  threshold = excluded.threshold, created_at = now()
            """,
            (asset_id, item["candidate_media_asset_id"], method, similarity, distance,
             _json({"max_hamming_distance": 12} if method == "phash" else {"min_similarity": 0.92}),
             asset_id, item["candidate_media_asset_id"]),
        )

    def _complete_canonical_publication(
        self,
        payload: dict[str, Any],
        *,
        expected_job_kind: str,
        require_wordpress_eligibility: bool,
    ) -> None:
        job_id = payload.get("p_job_id")
        if not _valid_uuid(job_id):
            raise GatewayError("Invalid publication job id")
        if not _text(payload.get("p_cdn_key")) or not _text(payload.get("p_cdn_url")):
            raise GatewayError("Invalid CDN publication")
        canonical_version = payload.get("p_canonical_version")
        canonical_slug = _text(payload.get("p_canonical_slug"))
        if expected_job_kind == "publish_canonical_media":
            if not isinstance(canonical_version, int) or canonical_version < 1:
                raise GatewayError("Invalid canonical publication version")
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", canonical_slug):
                raise GatewayError("Invalid canonical publication slug")
        try:
            with self.repository.transaction() as cursor:
                cursor.execute(
                    "select j.media_asset_id, a.title, coalesce(a.suggested_caption, '') as caption, a.review_state, a.permission, a.media_type, a.canonical_version from public.media_ingest_jobs j join public.media_assets a on a.id = j.media_asset_id where j.id = %s and j.job_kind = %s and j.status = 'processing' and a.deleted_at is null for update",
                    (job_id, expected_job_kind),
                )
                row = cursor.fetchone()
                if not row:
                    raise GatewayError("Publish job is not leased")
                if isinstance(row, Mapping):
                    asset_id, title, caption, review_state, permission, media_type, current_version = (row.get(key) for key in ("media_asset_id", "title", "caption", "review_state", "permission", "media_type", "canonical_version"))
                else:
                    asset_id, title, caption, review_state, permission, media_type, current_version = row
                if require_wordpress_eligibility and (review_state != "approved" or permission != "public"):
                    raise GatewayError("Asset is not eligible for WordPress publication")
                if expected_job_kind == "publish_canonical_media" and int(current_version or 1) != canonical_version:
                    cursor.execute(
                        "update public.media_ingest_jobs set status = 'succeeded', result = %s::jsonb, locked_at = null, locked_by = null, completed_at = now(), updated_at = now() where id = %s",
                        (_json({"stale": True, "canonical_version": canonical_version, "current_version": current_version}), job_id),
                    )
                    return
                cdn_key = _text(payload.get("p_cdn_key"))
                cdn_url = _text(payload.get("p_cdn_url"))
                renditions = payload.get("p_renditions")

                if media_type != "video":
                    if not isinstance(renditions, list) or len(renditions) == 0:
                        raise GatewayError("Photo publication requires non-empty renditions")

                    seen_tuples: set[tuple[str, str, int]] = set()
                    fingerprints_by_pair: dict[tuple[str, str], str] = {}
                    normalized_renditions: list[dict[str, Any]] = []

                    for r in renditions:
                        purp = str(r.get("purpose") or "web-responsive")
                        fmt = str(r.get("format") or "webp")
                        width = int(r.get("width") or 0)
                        height = int(r.get("height") or 0)
                        size_bytes = int(r.get("size_bytes") or 0)
                        r_cdn_key = str(r.get("cdn_key") or "").strip()
                        r_cdn_url = str(r.get("cdn_url") or "").strip()
                        mime = str(r.get("mime_type") or "image/webp").strip()
                        fp = str(r.get("rendition_fingerprint") or "").strip()
                        meta_ver = int(r.get("metadata_version") or 1)

                        if width <= 0 or height <= 0 or size_bytes <= 0 or not r_cdn_key or not r_cdn_url or not fp:
                            raise GatewayError("Incomplete rendition payload")

                        tuple_key = (purp, fmt, width)
                        if tuple_key in seen_tuples:
                            raise GatewayError(f"Duplicate rendition width {width} for {purp}/{fmt}")
                        seen_tuples.add(tuple_key)

                        pair_key = (purp, fmt)
                        if pair_key in fingerprints_by_pair and fingerprints_by_pair[pair_key] != fp:
                            raise GatewayError(f"Mismatched rendition fingerprint for {purp}/{fmt}")
                        fingerprints_by_pair[pair_key] = fp

                        normalized_renditions.append({
                            "purpose": purp,
                            "format": fmt,
                            "width": width,
                            "height": height,
                            "size_bytes": size_bytes,
                            "cdn_key": r_cdn_key,
                            "cdn_url": r_cdn_url,
                            "mime_type": mime,
                            "rendition_fingerprint": fp,
                            "metadata_version": meta_ver,
                        })

                    # Replace current set: DELETE current active set for the touched (purpose, format) pairs, then INSERT complete new set
                    for purp, fmt in fingerprints_by_pair.keys():
                        cursor.execute(
                            "delete from public.media_renditions where media_asset_id = %s and purpose = %s and format = %s",
                            (asset_id, purp, fmt),
                        )

                    for r in normalized_renditions:
                        cursor.execute(
                            """
                            insert into public.media_renditions (
                                media_asset_id, purpose, format, width, height, size_bytes,
                                cdn_key, cdn_url, mime_type, rendition_fingerprint, metadata_version, updated_at
                            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                            """,
                            (
                                asset_id,
                                r["purpose"],
                                r["format"],
                                r["width"],
                                r["height"],
                                r["size_bytes"],
                                r["cdn_key"],
                                r["cdn_url"],
                                r["mime_type"],
                                r["rendition_fingerprint"],
                                r["metadata_version"],
                            ),
                        )
                if expected_job_kind == "publish_canonical_media":
                    cursor.execute(
                        "update public.media_assets set canonical_slug = %s, canonical_published_version = %s, canonical_published_at = now(), cdn_key = %s, cdn_url = %s, publish_status = 'published', published_at = now() where id = %s and deleted_at is null",
                        (canonical_slug, canonical_version, cdn_key, cdn_url, asset_id),
                    )
                else:
                    cursor.execute("update public.media_assets set cdn_key = %s, cdn_url = %s, publish_status = 'published', published_at = now() where id = %s and deleted_at is null", (cdn_key, cdn_url, asset_id))
                if require_wordpress_eligibility:
                    cursor.execute(
                        """
                        insert into public.wordpress_media_exports (media_asset_id, cdn_url, alt_text, caption, width, height, mime_type, updated_at)
                        values (%s, %s, coalesce(nullif(%s, ''), %s), %s, %s, %s, %s, now())
                        on conflict (media_asset_id) do update set cdn_url = excluded.cdn_url, alt_text = excluded.alt_text, caption = excluded.caption, width = excluded.width, height = excluded.height, mime_type = excluded.mime_type, updated_at = now()
                        """,
                        (asset_id, cdn_url, caption, title or "", caption, payload.get("p_width"), payload.get("p_height"), payload.get("p_mime_type")),
                    )
                cursor.execute("update public.media_ingest_jobs set status = 'succeeded', result = %s::jsonb, locked_at = null, locked_by = null, completed_at = now(), updated_at = now() where id = %s", (_json({"cdn_url": cdn_url, "canonical_slug": canonical_slug or None, "renditions_count": len(renditions) if isinstance(renditions, list) else 0}), job_id))
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"Could not complete publication: {type(error).__name__}: {error}") from error

    def _complete_wordpress_publish(self, payload: dict[str, Any]) -> None:
        self._complete_canonical_publication(
            payload,
            expected_job_kind="publish_wordpress",
            require_wordpress_eligibility=True,
        )

    def _complete_canonical_media_publish(self, payload: dict[str, Any]) -> None:
        self._complete_canonical_publication(
            payload,
            expected_job_kind="publish_canonical_media",
            require_wordpress_eligibility=False,
        )

    def _fail_media_ingest_job(self, payload: dict[str, Any]) -> None:
        job_id = payload.get("p_job_id")
        message = str(payload.get("p_error_message") or "Unknown worker error")[:2000]
        retryable = bool(payload.get("p_retryable", True))
        if not _valid_uuid(job_id):
            raise GatewayError("Invalid worker job id")
        try:
            with self.repository.transaction() as cursor:
                cursor.execute("select media_asset_id, job_kind, attempts, max_attempts from public.media_ingest_jobs where id = %s and status = 'processing' for update", (job_id,))
                row = cursor.fetchone()
                if not row:
                    raise GatewayError("Job is not leased")
                if isinstance(row, Mapping):
                    asset_id, job_kind, attempts, max_attempts = (row.get(key) for key in ("media_asset_id", "job_kind", "attempts", "max_attempts"))
                else:
                    asset_id, job_kind, attempts, max_attempts = row
                terminal = (not retryable) or int(attempts) >= int(max_attempts)
                status = "failed" if terminal else "queued"
                cursor.execute(
                    "update public.media_ingest_jobs set status = %s, error_message = %s, run_after = case when %s then run_after else now() + least(900, 15 * attempts * attempts) * interval '1 second' end, locked_at = null, locked_by = null, completed_at = case when %s then now() else null end, updated_at = now() where id = %s",
                    (status, message, terminal, terminal, job_id),
                )
                if terminal and job_kind == "analyze_image":
                    cursor.execute("update public.media_assets set ingest_status = 'failed', ingest_error = %s where id = %s and deleted_at is null", (message, asset_id))
                elif terminal and job_kind in {"publish_wordpress", "publish_canonical_media"}:
                    cursor.execute("update public.media_assets set publish_status = 'failed' where id = %s and deleted_at is null", (asset_id,))
                elif terminal and job_kind == "prepare_reference":
                    cursor.execute(
                        """
                        update public.product_intakes pi
                           set reference_status = case when exists (
                                  select 1
                                  from public.sku_references r
                                  join public.reference_embeddings re on re.reference_id = r.reference_id
                                  join public.embedding_runtime_state ers on ers.active_space_id = re.space_id
                                  join public.embedding_spaces es on es.space_id = ers.active_space_id
                                  join public.media_assets source on source.id = r.source_media_asset_id
                                  where r.sku = pi.final_sku and r.is_active and r.match_eligible
                                    and es.status = 'ACTIVE' and source.deleted_at is null
                                    and nullif(lower(source.content_hash), '') = lower(re.source_sha256)
                               ) then 'ready' else 'failed' end,
                               reference_error = case when exists (
                                  select 1
                                  from public.sku_references r
                                  join public.reference_embeddings re on re.reference_id = r.reference_id
                                  join public.embedding_runtime_state ers on ers.active_space_id = re.space_id
                                  join public.embedding_spaces es on es.space_id = ers.active_space_id
                                  join public.media_assets source on source.id = r.source_media_asset_id
                                  where r.sku = pi.final_sku and r.is_active and r.match_eligible
                                    and es.status = 'ACTIVE' and source.deleted_at is null
                                    and nullif(lower(source.content_hash), '') = lower(re.source_sha256)
                               ) then null else %s end,
                               reference_updated_at = now(), updated_at = now()
                         where pi.id = (select payload->>'product_intake_id' from public.media_ingest_jobs where id = %s)
                           and pi.status = 'approved'
                        """,
                        (message, job_id),
                    )
        except GatewayError:
            raise
        except Exception as error:
            raise GatewayError(f"Could not fail worker job: {type(error).__name__}: {error}") from error

    def rpc(self, function_name: str, payload: dict[str, Any]) -> Any:
        """Compatibility dispatcher preserving the worker's durable RPC API."""

        if function_name == "match_sku_reference_candidates":
            return self.match_sku_reference_candidates(
                payload.get("p_embedding"),
                payload.get("p_match_count", 20),
                brand=payload.get("p_brand"),
            )
        if function_name == "match_scene_duplicate_candidates":
            return self.match_scene_duplicate_candidates(payload["p_media_asset_id"], payload["p_embedding"], payload.get("p_threshold", .92), payload.get("p_match_count", 10))
        if function_name == "match_phash_duplicate_candidates":
            return self.match_phash_duplicate_candidates(payload["p_media_asset_id"], payload["p_phash"], payload.get("p_max_distance", 12), payload.get("p_match_count", 10))
        if function_name == "get_metadata_few_shot_examples":
            return self.metadata_examples()
        if function_name == "complete_media_analysis":
            return self._complete_media_analysis(payload)
        if function_name == "complete_video_analysis":
            return self._complete_video_analysis(payload)
        if function_name == "complete_wordpress_publish":
            return self._complete_wordpress_publish(payload)
        if function_name == "complete_canonical_media_publish":
            return self._complete_canonical_media_publish(payload)
        if function_name == "complete_product_intake_reference":
            return self._complete_product_intake_reference(payload)
        if function_name == "fail_media_ingest_job":
            return self._fail_media_ingest_job(payload)
        raise GatewayError(f"Unsupported native worker operation: {function_name}")


# Descriptive alias for callers that refer to the SQL boundary by its storage
# backend rather than by the migration phase name.
PostgresGateway = NativeGateway
