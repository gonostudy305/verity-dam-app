"""Direct PostgreSQL/R2 MCP gateway for the native runtime."""
from __future__ import annotations
import json
import mimetypes
import sys
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('image/heic', '.heic')
mimetypes.add_type('image/heif', '.heif')
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from app.postgres_repository import PostgresRepository, PostgresSettings
from app.r2_storage import R2Settings, R2Storage
from app.space_resolver import SpaceResolver
from app.reference_promotion import (
    resolve_reference_role,
    should_promote_to_reference_corpus,
)
from verity_dam_mcp.auth import BotSession
from verity_dam_mcp.settings import McpSettings

class GatewayError(RuntimeError): pass

_ALLOWED_UPLOAD_MIME = {
    'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
}


def _escape_ilike(value: str) -> str:
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _derive_human_title(asset: dict[str, Any], fallback: str | None = None) -> str | None:
    """Return a usable title without persisting a raw upload filename.

    MCP callers may provide either ``title`` or ``file_name``.  Numeric names
    such as ``16.jpg`` are upload artifacts; when identity/context is present,
    compose a title from that metadata, otherwise leave the asset untitled so
    the pending review workflow can supply a human decision.
    """
    from app.image_processing import compose_canonical_title, is_generic_or_raw_title

    for key in ('title', 'file_name'):
        candidate = asset.get(key)
        if isinstance(candidate, str) and candidate.strip() and not is_generic_or_raw_title(candidate):
            return candidate.strip()[:200]

    composed = compose_canonical_title(asset)
    if composed and not is_generic_or_raw_title(composed):
        return composed[:200]

    if isinstance(fallback, str) and fallback.strip() and not is_generic_or_raw_title(fallback):
        return fallback.strip()[:200]
    return None


class MediaMcpGateway:
    def __init__(self, settings: McpSettings, bot_session: BotSession | None = None, space_resolver: SpaceResolver | None = None):
        self.settings = settings
        self.bot_session = bot_session
        try:
            self.repository = PostgresRepository(PostgresSettings(database_url=settings.database_url))
            self.storage = R2Storage(R2Settings(settings.r2_endpoint, settings.r2_access_key_id, settings.r2_secret_access_key, settings.r2_bucket, settings.r2_region, settings.r2_public_base_url))
        except Exception as error:
            raise GatewayError(f'Native MCP backend unavailable: {error}') from error
        self.space_resolver = space_resolver or SpaceResolver(self.repository)
        self._user_id: str | None = None
        self._role: str | None = None

    def user_id(self) -> str:
        from verity_dam_mcp.auth_middleware import current_agent_user_id

        active_user_id = current_agent_user_id.get()
        if active_user_id:
            return active_user_id

        if self._user_id and self._role:
            return self._user_id
        if self.settings.bot_user_id:
            row = self.repository.fetch_one('select id, email, role from public."user" where id=%s limit 1', (self.settings.bot_user_id,))
        else:
            row = self.repository.fetch_one('select id, email, role from public."user" where lower(email) = lower(%s) limit 1', (self.settings.bot_email,))
        if not row or not row.get('id'):
            raise GatewayError('MCP Better Auth user was not found; provision the account before starting MCP')
        role = str(row.get('role') or 'viewer')
        if role not in {'viewer', 'contributor', 'reviewer', 'admin'}:
            raise GatewayError('MCP Better Auth user has an invalid role')
        self._user_id = str(row['id'])
        self._role = role
        return self._user_id

    def _require_role(self, *allowed: str) -> str:
        from verity_dam_mcp.auth_middleware import current_agent_role

        active_role = current_agent_role.get()
        if active_role:
            if active_role not in allowed:
                raise GatewayError(f'MCP account role {active_role!r} is not allowed for this operation')
            return self.user_id()

        user_id = self.user_id()
        if self._role not in allowed:
            raise GatewayError(f'MCP account role {self._role!r} is not allowed for this operation')
        return user_id

    def create_signed_urls(self, storage_paths: list[str], expires_in: int = 3600) -> dict[str, str]:
        # Originals are provenance/fallback objects. Canonical cdn_url is
        # selected from the database by formatting.py; never manufacture a
        # permanent raw-key URL for an agent.
        result: dict[str, str] = {}
        for path in sorted({p for p in storage_paths if isinstance(p, str) and p}):
            try:
                result[path] = self.storage.presign_download(path, scope_prefix=path.split('/')[0], expires_in=expires_in)
            except Exception: continue
        return result

    def upload_object(self, storage_path: str, content: bytes, filename: str) -> None:
        content_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
        if content_type not in _ALLOWED_UPLOAD_MIME:
            raise GatewayError(f'Unsupported upload MIME type: {content_type}')
        maximum = 200 * 1024 * 1024 if content_type.startswith('video/') else 50 * 1024 * 1024
        if not isinstance(content, bytes) or not content or len(content) > maximum:
            raise GatewayError('Upload is empty or exceeds the allowed media size')
        self.storage.put_bytes(storage_path, content, content_type)

    def find_asset_by_content_hash(self, content_hash: str) -> dict[str, Any] | None:
        self._require_role('contributor', 'reviewer', 'admin')
        return self.repository.fetch_one(
            """select a.id, a.review_state, q.id as review_queue_id
               from public.media_assets a
               left join public.review_queue q on q.media_asset_id = a.id
               where a.content_hash = %s and a.deleted_at is null
               order by a.created_at asc limit 1""",
            (content_hash.lower(),),
        )

    def search_media_assets(
        self,
        terms: list[str],
        filters: dict[str, str | None],
        *,
        include_deleted: bool = False,
        include_reported: bool = False,
        include_unfinished: bool = False,
        candidate_cap: int = 500,
    ) -> list[dict[str, Any]]:
        """Return a permission-eligible candidate pool for in-process ranking.

        Authorization and exact filters are applied in SQL before any row is
        handed to the ranker.  Text terms are bound parameters; when a staged
        lexical lookup returns zero rows, a bounded eligible-pool fallback lets
        the Vietnamese accent/fuzzy ranker recover without ever leaking an
        excluded row.  Oversized fallback pools fail closed.
        """

        self.user_id()
        if include_deleted and self._role != 'admin':
            raise GatewayError('Only the admin MCP account may include soft-deleted assets')
        if include_reported and self._role not in ('reviewer', 'admin'):
            raise GatewayError('Only reviewer or admin MCP accounts may include reported assets')
        if include_unfinished and self._role not in ('reviewer', 'admin'):
            raise GatewayError('Only reviewer or admin MCP accounts may include unfinished (needs-post-production) assets')
        cap = max(1, min(int(candidate_cap), 500))
        clauses: list[str] = []
        values: list[Any] = []
        if not include_deleted:
            clauses.append('a.deleted_at is null')
        if not include_reported:
            clauses.append(
                "not exists (select 1 from public.asset_reports r "
                "where r.media_asset_id = a.id and r.status in ('open','in_review'))"
            )
        if not include_unfinished:
            clauses.append('not a.needs_post_production')
        clauses.append("a.review_state = 'approved'")
        if self._role == 'viewer':
            clauses.append("a.permission = 'public'")
        for field in ('category', 'space', 'status', 'permission', 'media_type'):
            value = filters.get(field)
            if value:
                clauses.append(f'a.{field} = %s')
                values.append(value)
        base_where = ' and '.join(clauses)

        clean_terms = list(dict.fromkeys(term.strip() for term in terms if isinstance(term, str) and term.strip()))[:24]
        rows: list[dict[str, Any]] = []
        if clean_terms:
            patterns = [f"%{_escape_ilike(term)}%" for term in clean_terms]
            text_clause = """(
                a.title ilike any(%s::text[]) or a.sku ilike any(%s::text[])
                or a.brand ilike any(%s::text[]) or a.category ilike any(%s::text[])
                or a.space ilike any(%s::text[]) or a.suggested_caption ilike any(%s::text[])
                or a.description ilike any(%s::text[])
                or exists (select 1 from unnest(coalesce(a.keywords, array[]::text[])) keyword
                           where keyword ilike any(%s::text[]))
            )"""
            rows = self.repository.fetch_all(
                f"""select a.*,
                    exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report
                    from public.media_assets a where {base_where} and {text_clause} limit %s""",
                (*values, patterns, patterns, patterns, patterns, patterns, patterns, patterns, patterns, cap + 1),
            )

        if not rows:
            rows = self.repository.fetch_all(
                f"""select a.*,
                    exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report
                    from public.media_assets a where {base_where} order by a.created_at desc limit %s""",
                (*values, cap + 1),
            )
        if len(rows) > cap:
            raise GatewayError(
                f'Search candidate pool exceeded the safe cap of {cap}; add category, space, permission, or media_type'
            )
        return rows

    def reviewed_synonyms(self) -> list[dict[str, Any]]:
        self.user_id()
        row = self.repository.fetch_one(
            "select items from public.verity_synonyms_config where config_key='default' limit 1"
        )
        items = row.get('items') if isinstance(row, dict) else None
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []

    def embedding_runtime_status(self) -> dict[str, Any]:
        """Return non-secret versioned-space state for agent diagnostics."""

        self.user_id()
        state = self.space_resolver.get_runtime_state(force_refresh=True)
        spaces = self.repository.fetch_all(
            """select s.space_id, s.status, s.model_id, s.model_revision, s.dimension,
                      s.distance_metric, s.vision_artifact_sha256, s.text_artifact_sha256,
                      count(ae.embedding_id)::int as asset_embedding_count
                 from public.embedding_spaces s
                 left join public.asset_embeddings ae on ae.space_id = s.space_id and ae.kind = 'global'
                group by s.space_id, s.status, s.model_id, s.model_revision, s.dimension,
                         s.distance_metric, s.vision_artifact_sha256, s.text_artifact_sha256
                order by s.created_at asc"""
        )
        return {
            'active_space_id': state.get('active_space_id'),
            'nl_search_space_id': state.get('nl_search_space_id'),
            'mcp_text_search_mode': 'deterministic_lexical_exact_fuzzy',
            'semantic_selector_configured': bool(state.get('nl_search_space_id')),
            'semantic_runtime_used_by_mcp': False,
            'spaces': spaces,
        }

    def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        try:
            self.user_id()
            if table == 'media_assets':
                clauses: list[str] = []; values: list[Any] = []
                include_deleted = params.get('include_deleted') == 'true'
                if include_deleted and self._role != 'admin':
                    raise GatewayError('Only the admin MCP account may include soft-deleted assets')
                if not include_deleted:
                    clauses.append('a.deleted_at is null')
                if not params.get('id'):
                    include_reported = params.get('include_reported') == 'true'
                    if include_reported and self._role not in {'reviewer', 'admin'}:
                        raise GatewayError('Only reviewer or admin MCP accounts may include reported assets')
                    if not include_reported:
                        clauses.append(
                            "not exists (select 1 from public.asset_reports r "
                            "where r.media_asset_id = a.id and r.status in ('open','in_review'))"
                        )
                    include_unfinished = params.get('include_unfinished') == 'true'
                    if include_unfinished and self._role not in {'reviewer', 'admin'}:
                        raise GatewayError('Only reviewer or admin MCP accounts may include unfinished (needs-post-production) assets')
                    if not include_unfinished:
                        clauses.append('not a.needs_post_production')
                for field in ('review_state','category','space','status','permission','media_type'):
                    raw = params.get(field)
                    if raw and raw.startswith('eq.') and (field != 'review_state' or self._role in {'reviewer', 'admin'}): clauses.append(f'a.{field} = %s'); values.append(raw[3:])
                if self._role not in {'reviewer', 'admin'}: clauses.append("a.review_state = 'approved'")
                if self._role == 'viewer': clauses.append("a.permission = 'public'")
                if params.get('id','').startswith('eq.'): clauses.append('a.id = %s'); values.append(params['id'][3:])
                if params.get('id','').startswith('in.'): clauses.append('a.id = any(%s::uuid[])'); values.append(params['id'][4:-1].split(','))
                where = ' and '.join(clauses) or 'true'
                return self.repository.fetch_all(
                    f"""select a.*,
                        exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report
                        from public.media_assets a where {where} order by a.created_at desc limit %s offset %s""",
                    (*values, int(params.get('limit','100')), int(params.get('offset','0')))
                )
            if table == 'review_queue':
                self._require_role('reviewer', 'admin')
                return self.repository.fetch_all(
                    """select q.id, q.media_asset_id, q.status, q.metadata_draft, q.is_duplicate, q.duplicate_asset_ids, q.created_at,
                       row_to_json(a) as media_assets from public.review_queue q join public.media_assets a on a.id=q.media_asset_id
                       where q.status='pending' and a.deleted_at is null
                         and not exists (
                           select 1 from public.product_intake_assets pia
                           join public.product_intakes pi on pi.id = pia.intake_id
                           where pia.media_asset_id = a.id
                             and pi.status in ('draft', 'submitted', 'needs_changes')
                         )
                       order by q.created_at asc limit %s offset %s""",
                    (int(params.get('limit','100')), int(params.get('offset','0'))))
            if table == 'asset_embeddings':
                clauses = []
                values = []
                if params.get('asset_id', '').startswith('eq.'):
                    clauses.append('ae.asset_id = %s')
                    values.append(params['asset_id'][3:])
                if params.get('space_id', '').startswith('eq.'):
                    clauses.append('ae.space_id = %s')
                    values.append(params['space_id'][3:])
                if params.get('kind', '').startswith('eq.'):
                    clauses.append('ae.kind = %s')
                    values.append(params['kind'][3:])
                else:
                    clauses.append("ae.kind = 'global'")
                where = ' and '.join(clauses) or 'true'
                return self.repository.fetch_all(
                    f"select ae.embedding_id, ae.asset_id, ae.space_id, ae.kind, ae.vector::text as vector from public.asset_embeddings ae where {where} limit %s offset %s",
                    (*values, int(params.get('limit', '100')), int(params.get('offset', '0'))),
                )
            raise GatewayError(f'Unsupported native select table: {table}')
        except Exception as error:
            if isinstance(error, GatewayError): raise
            raise GatewayError(f'PostgreSQL select failed: {error}') from error

    def rpc(self, function_name: str, payload: dict[str, Any]) -> Any:
        try:
            if function_name == 'match_media_assets_by_image_embedding':
                self._require_role('viewer', 'contributor', 'reviewer', 'admin')
                active_space = payload.get('p_space_id') or self.space_resolver.get_active_space_id()
                min_sim = float(payload.get('p_min_similarity', .75))
                rows = self.repository.fetch_all(
                    """select a.id as media_asset_id, (1-(ae.vector <=> %s::vector))::real as similarity
                       from public.media_assets a
                       join public.asset_embeddings ae on ae.asset_id = a.id and ae.space_id = %s and ae.kind = 'global'
                       where a.deleted_at is null and a.review_state='approved' and ae.vector is not null
                       and (not %s or a.permission='public') and 1-(ae.vector <=> %s::vector) >= %s
                       order by ae.vector <=> %s::vector limit %s""",
                    (payload['p_embedding'], active_space, bool(payload.get('p_public_only')), payload['p_embedding'], min_sim, payload['p_embedding'], int(payload.get('p_match_count', 20))))
                return rows
            if function_name == 'finalize_upload_batch': self._require_role('contributor', 'reviewer', 'admin'); return self._finalize(payload)
            if function_name == 'resolve_review_item': self._require_role('reviewer', 'admin'); return self._resolve(payload)
            if function_name == 'update_media_asset_metadata': self._require_role('reviewer', 'admin'); return self._update_metadata(payload)
            if function_name == 'save_media_crop_config': self._require_role('reviewer', 'admin'); return self._save_crop(payload)
            raise GatewayError(f'Unsupported native MCP operation: {function_name}')
        except Exception as error:
            if isinstance(error, GatewayError): raise
            raise GatewayError(f'Native MCP operation failed: {error}') from error

    def _finalize(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        # UploadAssetInput.context (see models.py) is documented as "stored on
        # the asset's origin_info" but this handler used to just never read
        # p_context at all -- it's a hand-rolled re-implementation of the
        # finalize_upload_batch SQL function, not a call to it, so that
        # function's own p_context handling never applied here either.
        user_id = self.user_id(); result: list[dict[str, Any]] = []
        context = (payload.get('p_context') or '').strip() or None
        with self.repository.transaction() as cursor:
            for upload in payload.get('p_uploads', []):
                # -------------------------------------------------------------
                # Dev Curated Lane: Precomputed embedding, approved bypass, SKU
                # -------------------------------------------------------------
                if upload.get('is_curated_import'):
                    source_provider = upload.get('source_provider', 'google_drive')
                    source_file_id = upload.get('source_file_id')
                    path = upload['storage_path']

                    # Exactly-once idempotency: check by (source_provider, source_file_id)
                    existing_id = None
                    if source_provider and source_file_id:
                        cursor.execute(
                            "select id from public.media_assets where source_provider=%s and source_file_id=%s and deleted_at is null",
                            (source_provider, source_file_id),
                        )
                        row = cursor.fetchone()
                        if row:
                            existing_id = row[0]

                    if not existing_id:
                        cursor.execute("select id from public.media_assets where storage_path=%s and deleted_at is null", (path,))
                        row = cursor.fetchone()
                        if row:
                            existing_id = row[0]
                    if existing_id:
                        if upload.get('update_existing_metadata'):
                            title_update = _derive_human_title(upload)
                            cursor.execute("""
                                update public.media_assets
                                set title = coalesce(%s, title),
                                    suggested_caption = coalesce(%s, suggested_caption),
                                    description = coalesce(%s, description),
                                    keywords = coalesce(%s, keywords),
                                    canonical_slug = coalesce(%s, canonical_slug),
                                    updated_at = now()
                                where id = %s
                            """, (
                                title_update,
                                upload.get('suggested_caption'),
                                upload.get('description'),
                                upload.get('keywords'),
                                upload.get('canonical_slug'),
                                existing_id,
                            ))
                        result.append({
                            'media_asset_id': str(existing_id),
                            'review_queue_id': None,
                            'is_duplicate': False,
                            'duplicate_asset_ids': [],
                            'status': 'already_imported',
                        })
                        continue
                    embedding_bundle = upload.get('embedding')
                    vec_literal = None
                    if embedding_bundle:
                        vec = embedding_bundle.get('vector')
                        space_id = embedding_bundle.get('space_id', 'verity-siglip2-b32-256-webli-v1')
                        if not vec or len(vec) != 768:
                            raise GatewayError(f"[HARD GATE] Embedding dimension {len(vec) if vec else 0} != 768 rejected")
                        if space_id != 'verity-siglip2-b32-256-webli-v1':
                            raise GatewayError(f"[HARD GATE] Space mismatch: expected verity-siglip2-b32-256-webli-v1, got {space_id}")
                        vec_literal = "[" + ",".join(format(x, ".9g") for x in vec) + "]"

                    is_duplicate = bool(upload.get('is_duplicate', False))
                    duplicate_asset_ids = upload.get('duplicate_asset_ids') or []
                    duplicate_similarity = float(upload.get('duplicate_similarity') or 0.0)

                    if not is_duplicate and vec_literal:
                        cursor.execute("""
                            select ae.asset_id, (1 - (ae.vector <=> %s::vector))::real as similarity
                            from public.asset_embeddings ae
                            join public.media_assets ma on ma.id = ae.asset_id
                            where ae.space_id = %s and ae.kind = 'global'
                              and ma.deleted_at is null
                              and (1 - (ae.vector <=> %s::vector)) >= 0.95
                            order by similarity desc
                            limit 10
                        """, (vec_literal, space_id, vec_literal))
                        dup_rows = cursor.fetchall()
                        if dup_rows:
                            is_duplicate = True
                            duplicate_asset_ids = [str(r[0]) for r in dup_rows]
                            duplicate_similarity = float(dup_rows[0][1])
                    sku_val = upload.get('sku')
                    sku_match_payload = upload.get('sku_match')
                    requires_sku_conf = bool(isinstance(sku_match_payload, dict) and sku_match_payload.get('requires_reviewer_confirmation'))
                    approved_by_policy = upload.get('approved_by_policy')

                    # Invariant: Assets imported from external sources enter review_state = 'pending'
                    # unless explicitly authorized by a trusted auto-approval policy with a verified SKU.
                    if approved_by_policy and sku_val and not requires_sku_conf and not is_duplicate:
                        review_state = 'approved'
                    else:
                        review_state = 'pending'
                    permission = upload.get('permission', 'internal')
                    content_hash = upload.get('sha256')
                    batch_context = context or upload.get('project_hint') or upload.get('batch_context')
                    origin_info = {
                        'source': 'Google Drive Curated',
                        'uploader': str(user_id),
                        'batch_context': batch_context,
                        'source_provider': source_provider,
                        'source_file_id': source_file_id,
                        'import_batch_id': upload.get('import_batch_id'),
                    }
                    dimensions = upload.get('dimensions') or {'size_bytes': upload.get('size_bytes', 0)}
                    from app.image_processing import is_generic_or_raw_title, build_public_image_slug
                    clean_title = _derive_human_title(upload) or ''
                    if review_state == 'approved' and (
                        not isinstance(clean_title, str)
                        or not clean_title.strip()
                        or is_generic_or_raw_title(clean_title)
                    ):
                        # Never let an auto-approved asset carry a numeric or
                        # generated filename into the live library.
                        review_state = 'pending'
                    canonical_slug = upload.get('canonical_slug') or build_public_image_slug({**upload, 'title': clean_title})
                    import json
                    full_cdn_url = f"https://assets.verity.internal/{path.lstrip('/')}"
                    author = upload.get('author') or 'VerityDAM Platform'
                    copyright_str = upload.get('copyright') or '© 2026 VerityDAM Platform. All rights reserved.'
                    credit = upload.get('credit') or 'VerityDAM Team'
                    has_people = bool(upload.get('has_people', False))
                    ai_flags = {
                        'is_ai': False,
                        'is_internal': False,
                        'has_people': has_people,
                        'tag_failed': False,
                        'is_broken': False,
                    }
                    upload_flags = upload.get('ai_flags')
                    if isinstance(upload_flags, dict):
                        ai_flags.update(upload_flags)
                    cursor.execute("""
                        insert into public.media_assets(
                            title, file_url, thumbnail_url, storage_path, thumbnail_path,
                            media_type, permission, review_state, origin_info, dimensions,
                            created_by, sku, brand, category, sub_category, space, status,
                            suggested_caption, description, keywords, visible_text, content_hash,
                            author, copyright, credit, ai_flags, ai_confidence,
                            source_provider, source_file_id, source_modified_time, import_batch_id, source_md5,
                            ingest_status, ingested_at, canonical_slug
                        )
                        values (
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s::jsonb, %s::jsonb,
                            %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s,
                            %s, %s, %s, %s::jsonb, %s::jsonb,
                            %s, %s, %s, %s, %s,
                            'ready', now(), %s
                        ) returning id
                    """, (
                        clean_title, full_cdn_url, full_cdn_url, path, upload.get('thumbnail_path', path),
                        upload.get('media_type', 'photo'), permission, review_state, json.dumps(origin_info), json.dumps(dimensions),
                        user_id, upload.get('sku'), upload.get('brand'), upload.get('category'), upload.get('sub_category'), upload.get('space'), upload.get('status', 'Mới'),
                        upload.get('suggested_caption'), upload.get('description') or upload.get('suggested_caption') or '', upload.get('keywords', []), upload.get('visible_text'), content_hash,
                        author, copyright_str, credit, json.dumps(ai_flags),
                        json.dumps(upload.get('ai_confidence') or {}),
                        source_provider, source_file_id, upload.get('source_modified_time'), upload.get('import_batch_id'), upload.get('source_md5'),
                        canonical_slug,
                    ))
                    asset_id = cursor.fetchone()[0]
                    if embedding_bundle:
                        vec_literal = "[" + ",".join(format(x, ".9g") for x in embedding_bundle["vector"]) + "]"
                        cursor.execute("""
                            insert into public.asset_embeddings(asset_id, space_id, kind, vector, source_sha256)
                            values (%s, %s, 'global', %s::vector, %s)
                            on conflict (asset_id, space_id) where kind = 'global' do update set
                                vector = excluded.vector,
                                source_sha256 = excluded.source_sha256
                        """, (asset_id, space_id, vec_literal, content_hash))

                    # Confirmed SKU product link (if product exists in catalog)
                    sku = upload.get('sku')
                    if sku:
                        cursor.execute(
                            "select id from public.verity_products where code = %s or primary_sku = %s or display_name ilike %s limit 1",
                            (sku, sku, f"%{sku}%")
                        )
                        p_row = cursor.fetchone()
                        if p_row:
                            cursor.execute(
                                "delete from public.media_asset_products where media_asset_id = %s and role = 'primary' and product_id <> %s",
                                (asset_id, p_row[0])
                            )
                            cursor.execute("""
                                insert into public.media_asset_products(media_asset_id, product_id, role, source, review_state)
                                values (%s, %s, 'primary', 'google_drive_folder', 'confirmed')
                                on conflict (media_asset_id, product_id) do update set
                                    role = 'primary',
                                    source = 'google_drive_folder',
                                    review_state = 'confirmed'
                            """, (asset_id, p_row[0]))

                    # Persist embedding decisions in the existing review queue
                    # contract.  ``sku_match`` is intentionally not a
                    # media_assets column in native production; low-confidence
                    # and ambiguous decisions become pending review items,
                    # while an accepted high-confidence match is audit-visible
                    # without blocking the asset.
                    queue_id = None
                    sku_match_payload = upload.get('sku_match')
                    if isinstance(sku_match_payload, dict) and sku_match_payload:
                        sku_review_pending = bool(sku_match_payload.get('requires_reviewer_confirmation'))
                        cursor.execute(
                            """
                            insert into public.review_queue(media_asset_id, status, sku_match)
                            values (%s, %s, %s::jsonb)
                            on conflict (media_asset_id) do update set sku_match = excluded.sku_match
                            returning id
                            """,
                            (asset_id, 'pending' if (review_state == 'pending' or sku_review_pending) else 'approved', json.dumps(sku_match_payload)),
                        )
                        queue_id = cursor.fetchone()[0]
                    if review_state == 'pending':
                        cursor.execute(
                            """
                            insert into public.review_queue(media_asset_id, status, is_duplicate, duplicate_similarity, duplicate_asset_ids)
                            values (%s, 'pending', %s, %s, %s::jsonb)
                            on conflict (media_asset_id) do update set
                                status = excluded.status,
                                is_duplicate = excluded.is_duplicate,
                                duplicate_similarity = excluded.duplicate_similarity,
                                duplicate_asset_ids = excluded.duplicate_asset_ids
                            returning id
                            """,
                            (
                                asset_id,
                                is_duplicate,
                                duplicate_similarity,
                                json.dumps(duplicate_asset_ids),
                            ),
                        )
                        queue_id = cursor.fetchone()[0]

                    # ZERO worker queue load: NO analyze_image jobs inserted!
                    result.append({
                        'media_asset_id': str(asset_id),
                        'review_queue_id': str(queue_id) if queue_id else None,
                        'is_duplicate': is_duplicate,
                        'duplicate_asset_ids': duplicate_asset_ids,
                        'review_state': review_state,
                    })
                    continue

                # -------------------------------------------------------------
                # Standard User Upload Lane (preserved untouched)
                # -------------------------------------------------------------
                path = upload['storage_path']; existing = cursor.execute('select id from public.media_assets where storage_path=%s and deleted_at is null', (path,))
                row = cursor.fetchone()
                if row: asset_id = row[0]
                else:
                    safe_title = _derive_human_title({**upload, 'batch_context': context}) or 'Ảnh chờ duyệt'
                    content_hash = (upload.get('sha256') or '').lower() or None
                    source_ref = (upload.get('source_ref') or '').strip() or None
                    cursor.execute("""insert into public.media_assets(title,file_url,thumbnail_url,storage_path,thumbnail_path,media_type,permission,content_hash,review_state,origin_info,dimensions,created_by)
                      values (%s,%s,%s,%s,%s,%s,%s,%s,'pending',jsonb_strip_nulls(jsonb_build_object('source','MCP Upload','source_ref',%s,'uploader',%s,'batch_context',%s)),jsonb_build_object('size_bytes',0),%s) returning id""",
                      (safe_title,path,path,path,path,upload.get('media_type','photo'),upload.get('permission','internal'),content_hash,source_ref,user_id,context,user_id)); asset_id = cursor.fetchone()[0]
                cursor.execute("insert into public.review_queue(media_asset_id,status) values (%s,'pending') on conflict (media_asset_id) do update set media_asset_id=excluded.media_asset_id returning id", (asset_id,)); queue = cursor.fetchone()
                cursor.execute("insert into public.media_ingest_jobs(media_asset_id,job_kind,idempotency_key,payload) values (%s,'analyze_image',%s,%s::jsonb) on conflict (idempotency_key) do nothing", (asset_id, f'analyze_image:{asset_id}', '{}'))
                result.append({'media_asset_id': str(asset_id), 'review_queue_id': str(queue[0]), 'is_duplicate': False, 'duplicate_asset_ids': []})
        return result

    def _resolve(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        qid = payload['p_review_queue_id']; decision = payload['p_decision']; patch = payload.get('p_patch') or {}
        promote_reference = bool(payload.get('p_promote_reference', False))
        if decision not in {'approved', 'rejected'}:
            raise GatewayError('Review decision must be approved or rejected')
        with self.repository.transaction() as cursor:
            # Native SKU/product triggers use an app-layer actor GUC (there is
            # no database-side request identity in the PostgreSQL-native stack).
            # Set it for
            # every transaction, including rejection, so a pooled connection
            # can never inherit a stale human value.  Only approval may create
            # a confirmed/human product link.
            actor = 'human' if decision == 'approved' else 'machine'
            cursor.execute("select set_config('verity.sync_actor', %s, true)", (actor,))
            cursor.execute("select set_config('verity.sync_actor_id', %s, true)", (str(self.user_id()),))
            cursor.execute("""select q.media_asset_id, q.metadata_draft,
                jsonb_build_object('sku', a.sku, 'title', a.title, 'brand', a.brand, 'category', a.category,
                  'space', a.space, 'status', a.status, 'suggested_caption', a.suggested_caption,
                  'author', a.author, 'copyright', a.copyright, 'credit', a.credit,
                  'description', a.description, 'keywords', to_jsonb(a.keywords)) as before_value,
                exists(
                  select 1 from public.product_intake_assets pia
                  join public.product_intakes pi on pi.id = pia.intake_id
                  where pia.media_asset_id = a.id and pi.status in ('draft', 'submitted', 'needs_changes')
                ) as product_intake_open
                from public.review_queue q join public.media_assets a on a.id=q.media_asset_id
                where q.id=%s and q.status='pending' and a.deleted_at is null for update""", (qid,)); row = cursor.fetchone()
            if not row: raise GatewayError('Review item is no longer pending')
            if len(row) > 3 and bool(row[3]):
                raise GatewayError('PRODUCT_INTAKE_REVIEW_REQUIRED: review this asset in the product-intake workflow')
            asset_id = row[0]; metadata_draft = row[1] or {}; before = row[2] or {}; import json
            from app.image_processing import is_generic_or_raw_title
            if decision == 'approved':
                final_title = patch.get('title', before.get('title') or '')
                if not isinstance(final_title, str) or not final_title.strip() or is_generic_or_raw_title(final_title):
                    raise GatewayError('Approved media assets require a human-readable title')
            allowed_fields = {'title','sku','brand','category','space','status','suggested_caption','author','copyright','credit','description'}
            sets: list[str] = []
            values: list[Any] = []
            for field in allowed_fields:
                if field in patch:
                    sets.append(f"{field}=%s")
                    values.append(patch[field])
            if 'keywords' in patch and isinstance(patch['keywords'], list):
                sets.append('keywords=%s')
                values.append([str(value) for value in patch['keywords']])
            if patch.get('permission') in {'public', 'internal'}:
                sets.extend(['permission=%s', "ai_flags=jsonb_set(coalesce(ai_flags,'{}'::jsonb), '{is_internal}', %s::jsonb)"])
                values.extend([patch['permission'], 'true' if patch['permission'] == 'internal' else 'false'])
            sets.extend(['review_state=%s', 'updated_at=now()'])
            values.extend([decision, asset_id])
            cursor.execute(f"update public.media_assets set {', '.join(sets)} where id=%s", values)
            cursor.execute("update public.review_queue set status=%s,user_corrections=%s::jsonb,reviewed_by=%s,reviewed_at=now() where id=%s", (decision, __import__('json').dumps(payload.get('p_corrections') or {}), self.user_id(), qid))
            if decision == 'approved':
                cursor.execute("""select jsonb_build_object('sku', sku, 'title', title, 'brand', brand, 'category', category,
                    'space', space, 'status', status, 'suggested_caption', suggested_caption,
                    'author', author, 'copyright', copyright, 'credit', credit,
                    'description', description, 'keywords', to_jsonb(keywords))
                    from public.media_assets where id=%s""", (asset_id,))
                after = (cursor.fetchone() or ({},))[0] or {}
                corrections = payload.get('p_corrections') or {}
                sku_was_corrected = corrections.get('sku') is True and before.get('sku') != after.get('sku')
                should_write_reference = bool(after.get('sku')) and (sku_was_corrected or promote_reference)
                if sku_was_corrected:
                    cursor.execute("""insert into public.review_correction_log
                        (media_asset_id, review_queue_id, correction_kind, fields, before_value, after_value, reviewed_by)
                        values (%s,%s,'sku','[\"sku\"]'::jsonb,%s::jsonb,%s::jsonb,%s) returning id""",
                        (asset_id, qid, json.dumps({'sku': before.get('sku')}), json.dumps({'sku': after.get('sku')}), self.user_id()))
                    cursor.fetchone()
                if should_write_reference:
                    active_space = self.space_resolver.get_active_space_id()
                    cursor.execute(
                        """select 1 from public.asset_embeddings ae
                           where ae.asset_id = %s and ae.space_id = %s and ae.kind = 'global' and ae.vector is not null
                           limit 1""",
                        (asset_id, active_space),
                    )
                    if cursor.fetchone():
                        cursor.execute(
                            """select sku, category, ai_flags, ai_confidence from public.media_assets where id = %s""",
                            (asset_id,),
                        )
                        asset_info = cursor.fetchone()
                        # DAM correction remains valid for synthetic media, but
                        # synthetic assets must never enter the SKU matcher.
                        if asset_info and asset_info[0] and not bool((asset_info[2] or {}).get('is_ai')):
                            sku_val = asset_info[0]
                            cat_val = asset_info[1]
                            flags_val = asset_info[2] or {}
                            conf_val = asset_info[3] or {}

                            ctx = "scene"
                            if flags_val.get("non_catalog"):
                                ctx = "scene"
                            elif cat_val and cat_val.strip().lower() == "studio":
                                ctx = "product"
                            elif cat_val and cat_val.strip().lower() == "banner":
                                ctx = "marketing"

                            is_prom = should_promote_to_reference_corpus(
                                context=ctx,
                                has_people=bool(flags_val.get("has_people")),
                                sku_confidence=conf_val.get("sku"),
                                explicit_opt_in=promote_reference,
                            )

                            cursor.execute(
                                """select count(*) from public.media_asset_products
                                   where media_asset_id = %s and review_state != 'rejected'""",
                                (asset_id,),
                            )
                            cnt_row = cursor.fetchone()
                            link_cnt = cnt_row[0] if cnt_row else 1

                            cursor.execute(
                                """select exists(
                                     select 1 from public.sku_references
                                     where sku = %s and is_active = true and match_eligible = true and source_media_asset_id is distinct from %s
                                   )""",
                                (sku_val, asset_id),
                            )
                            has_active_ref = bool(cursor.fetchone()[0])

                            ref_role, cur_status, match_elig, img_cat = resolve_reference_role(
                                is_promoted=is_prom,
                                has_active_reference_for_sku=has_active_ref,
                                category=cat_val,
                                product_link_count=link_cnt,
                            )

                            cursor.execute(
                                """insert into public.sku_references
                                     (sku, source_media_asset_id, reference_role, image_category, curation_status, is_active, match_eligible, is_primary, created_by)
                                   values (%s, %s, %s, %s, %s, true, %s, %s, %s)
                                   on conflict (sku, source_media_asset_id) where source_media_asset_id is not null
                                   do update set reference_role = excluded.reference_role,
                                                 image_category = excluded.image_category,
                                                 curation_status = excluded.curation_status,
                                                 match_eligible = excluded.match_eligible,
                                                 is_primary = public.sku_references.is_primary OR excluded.is_primary,
                                                 updated_at = now()
                                   returning reference_id""",
                                (sku_val, asset_id, ref_role, img_cat, cur_status, match_elig, bool(is_prom and not has_active_ref), self.user_id()),
                            )
                            ref_row = cursor.fetchone()
                            if is_prom and ref_row:
                                reference_id = ref_row[0]
                                write_spaces = self.space_resolver.resolve_representation_write_spaces()
                                for space in write_spaces:
                                    cursor.execute(
                                        """insert into public.reference_embeddings (reference_id, space_id, vector, source_sha256)
                                           select %s, ae.space_id, ae.vector, ae.source_sha256
                                           from public.asset_embeddings ae
                                           where ae.asset_id = %s and ae.space_id = %s and ae.kind = 'global' and ae.vector is not null
                                           on conflict (reference_id, space_id)
                                           do update set vector = excluded.vector, source_sha256 = excluded.source_sha256""",
                                        (reference_id, asset_id, space),
                                    )
                metadata_fields = [field for field, corrected in corrections.items() if corrected is True and field in {'title','brand','category','space','status','suggested_caption','author','copyright','credit','description','keywords'}]
                if metadata_fields:
                    cursor.execute("""insert into public.review_correction_log
                        (media_asset_id, review_queue_id, correction_kind, fields, before_value, after_value, reviewed_by)
                        values (%s,%s,'metadata',%s::jsonb,%s::jsonb,%s::jsonb,%s) returning id""",
                        (asset_id, qid, json.dumps(metadata_fields), json.dumps(before), json.dumps(after), self.user_id()))
                    correction_log_id = cursor.fetchone()[0]
                    cursor.execute("""insert into public.metadata_few_shot_examples
                        (source_media_asset_id, correction_log_id, input_context, accepted_metadata, created_by)
                        select id, %s, jsonb_build_object('origin_info', origin_info, 'model_draft', %s::jsonb), %s::jsonb - 'sku', %s
                        from public.media_assets
                        where id=%s
                          and coalesce(ai_flags -> 'is_ai', 'false'::jsonb) <> 'true'::jsonb""",
                        (correction_log_id, json.dumps(metadata_draft), json.dumps(after), self.user_id(), asset_id))
        return [{'media_asset_id': str(asset_id), 'review_queue_id': str(qid), 'review_status': decision}]

    def _update_metadata(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        patch = payload.get('p_patch') or {}; asset_id = payload['p_media_asset_id']; allowed = {'title','brand','category','space','status','suggested_caption','author','copyright','credit','description'}
        if 'title' in patch:
            from app.image_processing import is_generic_or_raw_title
            title = patch['title']
            if not isinstance(title, str) or not title.strip() or is_generic_or_raw_title(title):
                raise GatewayError('Media title must be human-readable, not a numeric or generated filename')
        sets = []; values: list[Any] = []
        for key in allowed:
            if key in patch: sets.append(f'{key}=%s'); values.append(patch[key])
        if not sets: return []
        values.append(asset_id)
        with self.repository.transaction() as cursor: cursor.execute(f"update public.media_assets set {', '.join(sets)}, updated_at=now() where id=%s and deleted_at is null and review_state <> 'pending' returning id", values); row=cursor.fetchone()
        return [{'media_asset_id': str(row[0]), 'updated_fields': [key for key in allowed if key in patch]}] if row else []

    def _save_crop(self, payload: dict[str, Any]) -> Any:
        asset_id = payload['p_media_asset_id']; preset = payload['p_preset_id']; crop = payload['p_crop']
        import json
        if not isinstance(crop, dict) or not isinstance(preset, str) or preset not in {'1:1', '9:16', '16:9', '4:5', 'free'}:
            raise GatewayError('Invalid crop payload')
        required = ('x', 'y', 'width', 'height')
        if any(not isinstance(crop.get(key), (int, float)) or isinstance(crop.get(key), bool) or not math.isfinite(float(crop[key])) for key in required):
            raise GatewayError('Crop coordinates must be finite numbers')
        if any(float(crop[key]) < 0 for key in required) or float(crop['width']) <= 0 or float(crop['height']) <= 0:
            raise GatewayError('Crop coordinates must be non-negative and have positive size')
        with self.repository.transaction() as cursor:
            cursor.execute("select coalesce(origin_info,'{}'::jsonb), dimensions from public.media_assets where id=%s and deleted_at is null and review_state <> 'rejected' for update", (asset_id,)); row=cursor.fetchone()
            if not row: raise GatewayError('Media asset not found')
            dimensions = row[1] if isinstance(row[1], dict) else {}
            width, height = float(dimensions.get('width') or 0), float(dimensions.get('height') or 0)
            if width > 0 and height > 0 and (float(crop['x']) + float(crop['width']) > width or float(crop['y']) + float(crop['height']) > height):
                raise GatewayError('Crop exceeds original media dimensions')
            origin = row[0] if isinstance(row[0], dict) else {}; configs = origin.get('crop_configs', {}) if isinstance(origin, dict) else {}; configs[preset] = crop
            origin['crop_configs'] = configs; cursor.execute("update public.media_assets set origin_info=%s::jsonb,updated_at=now() where id=%s", (json.dumps(origin), asset_id)); return configs

    def fetch_usage_history(self, asset_id: str, limit: int = 20) -> list[dict[str, Any]]:
        self._require_role('viewer', 'contributor', 'reviewer', 'admin')
        rows = self.repository.fetch_all(
            """select channel, used_by, note, used_at
               from public.media_usages
               where media_asset_id = %s
               order by used_at desc
               limit %s""",
            (asset_id, limit),
        )
        result = []
        for r in rows:
            used_at_val = r.get('used_at')
            if isinstance(used_at_val, datetime):
                used_at_str = used_at_val.isoformat()
            else:
                used_at_str = str(used_at_val or '')
            result.append({
                'channel': str(r.get('channel') or ''),
                'used_by': str(r.get('used_by') or ''),
                'note': r.get('note'),
                'used_at': used_at_str,
            })
        return result

    def record_usage(
        self, asset_id: str, channel: str, note: str | None = None, allow_unfinished: bool = False
    ) -> dict[str, Any]:
        """Insert a usage event into media_usages. Validates the asset exists and is approved.

        Fails closed on two conditions no discovery-time filter can guarantee an agent
        already respected, since ``media_get_asset`` deliberately bypasses discovery
        exclusion when fetching a specific known id:
        - an open issue report (never overridable — resolving the report is the only path)
        - ``needs_post_production`` (overridable via ``allow_unfinished``, reviewer/admin only)

        ``permission`` (internal/public) is intentionally not checked here — it is a
        human-facing UI label, not an MCP-enforced gate (see docs/brainstorm/
        2026-09-23-mcp-post-production-gate-and-output-truncation.md).
        """
        user_id = self._require_role('contributor', 'reviewer', 'admin')
        # Verify asset exists and is approved (fail closed — never record usage on phantom/pending assets)
        asset_row = self.repository.fetch_one(
            """select id, needs_post_production,
                      exists(select 1 from public.asset_reports r
                             where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report
                 from public.media_assets a
                where a.id = %s and a.deleted_at is null and a.review_state = 'approved' limit 1""",
            (asset_id,),
        )
        if not asset_row:
            raise GatewayError(
                f"Asset {asset_id!r} not found, deleted, or not yet approved — "
                "cannot record usage for an asset that is not live."
            )
        if asset_row.get('has_open_report'):
            raise GatewayError(
                f"Asset {asset_id!r} has an open issue report — resolve the report before recording external usage."
            )
        if asset_row.get('needs_post_production') and not allow_unfinished:
            raise GatewayError(
                f"Asset {asset_id!r} is flagged needs_post_production — cannot record external usage "
                "without allow_unfinished=true from a reviewer/admin account."
            )
        if asset_row.get('needs_post_production') and allow_unfinished:
            self._require_role('reviewer', 'admin')
        with self.repository.transaction() as cursor:
            cursor.execute(
                """insert into public.media_usages (media_asset_id, channel, used_by, note)
                   values (%s, %s, %s, %s)
                   returning id, used_at""",
                (asset_id, channel.strip(), user_id, note),
            )
            row = cursor.fetchone()
        usage_id = str(row[0])
        used_at_val = row[1]
        used_at_str = used_at_val.isoformat() if isinstance(used_at_val, datetime) else str(used_at_val or '')
        return {'usage_id': usage_id, 'media_asset_id': asset_id, 'channel': channel.strip(), 'used_at': used_at_str}

    def log_tool_call(
        self,
        tool_name: str,
        bot_user_id: str | None,
        params_summary: dict[str, Any],
        result_summary: dict[str, Any],
        status: str,
        error_message: str | None = None,
        duration_ms: int | None = None,
        api_key_id: str | None = None,
    ) -> None:
        """Insert a tool execution audit event into mcp_tool_call_log.

        This method is strictly fire-and-forget: it never raises an exception,
        truncates fields according to database constraints, and logs any failure
        to sys.stderr.
        """
        try:
            name = str(tool_name or "")[:128]
            stat = "success" if status == "success" else "error"
            err = str(error_message)[:2000] if error_message is not None else None
            dur = max(0, int(duration_ms)) if duration_ms is not None else None
            p_sum = params_summary if isinstance(params_summary, dict) else {"raw": str(params_summary)[:300]}
            r_sum = result_summary if isinstance(result_summary, dict) else {"raw": str(result_summary)[:300]}

            uid = None
            raw_uid = bot_user_id or self._user_id
            if raw_uid:
                try:
                    uuid.UUID(str(raw_uid))
                    uid = str(raw_uid)
                except (ValueError, AttributeError):
                    uid = None

            key_id = None
            if api_key_id:
                try:
                    key_id = str(uuid.UUID(str(api_key_id)))
                except (ValueError, AttributeError):
                    key_id = None

            with self.repository.transaction() as cursor:
                cursor.execute(
                    """insert into public.mcp_tool_call_log
                       (tool_name, bot_user_id, params_summary, result_summary, status, error_message, duration_ms, api_key_id)
                       values (%s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s)""",
                    (name, uid, json.dumps(p_sum), json.dumps(r_sum), stat, err, dur, key_id),
                )
        except Exception as error:
            sys.stderr.write(f"[Verity_MCP_AUDIT_LOG_ERROR] Failed to record tool call log: {error}\n")

    def shared_vision_config(self) -> dict[str, Any]:
        """Fetch the active default shared vision configuration record."""
        row = self.repository.fetch_one(
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

    def fetch_confirmed_sku_matches(self, asset_id: str) -> list[dict[str, Any]]:
        """Fetch reviewer-approved or primary SKU matches linked to this asset."""
        rows = self.repository.fetch_all(
            """
            select p.code, p.primary_sku, p.display_name, p.brand, p.category, map.role, map.confidence
            from public.media_asset_products map
            join public.verity_products p on p.id = map.product_id
            where map.media_asset_id = %s and map.review_state in ('confirmed', 'approved')
            order by map.confidence desc nulls last
            """,
            (asset_id,),
        )
        if rows:
            return rows
        asset = self.repository.fetch_one(
            "select sku, brand, category from public.media_assets where id = %s limit 1",
            (asset_id,),
        )
        if asset and asset.get("sku"):
            return [{
                "code": str(asset["sku"]),
                "primary_sku": str(asset["sku"]),
                "display_name": None,
                "brand": asset.get("brand"),
                "category": asset.get("category"),
                "role": "primary",
                "confidence": 1.0,
            }]
        return []

    def usage_stats_on_channel(
        self, asset_id: str, channel: str, within_days: int = 14
    ) -> dict[str, Any]:
        """Fetch total count, recent count within window, and last_used_at timestamp in a single SQL query."""
        row = self.repository.fetch_one(
            """
            select
                count(*)::int as total_count,
                count(*) filter (where used_at >= now() - (%s * interval '1 day'))::int as recent_count,
                max(used_at) as last_used_at
            from public.media_usages
            where media_asset_id = %s
              and lower(channel) = lower(%s)
            """,
            (within_days, asset_id, channel.strip()),
        )
        total_count = int(row["total_count"]) if row and row.get("total_count") is not None else 0
        recent_count = int(row["recent_count"]) if row and row.get("recent_count") is not None else 0
        last_used = row.get("last_used_at") if row else None
        last_used_str = (
            last_used.isoformat() if isinstance(last_used, datetime) else str(last_used or "") if last_used else None
        )
        return {
            "used": recent_count > 0,
            "total_count": total_count,
            "recent_count": recent_count,
            "last_used_at": last_used_str,
            "channel": channel.strip().lower(),
            "within_days": within_days,
        }

    def recent_usage_on_channel(self, asset_id: str, channel: str, within_days: int = 30) -> dict[str, Any] | None:
        """Check if asset was deployed to channel within within_days (backward-compatible)."""
        stats = self.usage_stats_on_channel(asset_id, channel, within_days=within_days)
        if stats["used"]:
            return {
                "used": True,
                "count": stats["recent_count"],
                "last_used_at": stats["last_used_at"],
                "channel": stats["channel"],
                "within_days": within_days,
            }
        return None


