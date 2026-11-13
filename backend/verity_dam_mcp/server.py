"""The verity_dam_mcp tool surface for the native PostgreSQL/R2 runtime.

Every tool below is a thin wrapper around parameterized SQL transactions and
R2 operations. The gateway resolves the configured Better Auth user from
PostgreSQL and enforces its role before reads or writes. See docs/mcp-server.md
for the security model and deployment requirements.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import uuid
from datetime import datetime, timezone

import httpx

from mcp.server import MCPServer
from mcp_types import ToolAnnotations

from verity_dam_mcp import embedding
from verity_dam_mcp.auth import BotSession
from verity_dam_mcp.embedding import ConfigurationError, EmbeddingApiError
from verity_dam_mcp.formatting import _truncate, format_media_asset, render_assets_markdown, render_json
from verity_dam_mcp.gateway import GatewayError, MediaMcpGateway
from verity_dam_mcp.image_fit import evaluate_image_fit, find_best_image
from verity_dam_mcp.library_search import build_retrieval_terms, rank_library_rows
from verity_dam_mcp.models import (
    CandidateFit,
    EvaluateImageFitInput,
    EvaluateImageFitOutput,
    FindBestImageInput,
    FindBestImageOutput,
    GetAssetInput,
    ListLibraryInput,
    ListPendingReviewInput,
    MediaSearchInput,
    MediaSearchOutput,
    MediaUsageHistoryInput,
    MediaUsageHistoryOutput,
    MediaUsageItem,
    RecordUsageInput,
    RecordUsageOutput,
    ResolveReviewItemInput,
    SaveCropInput,
    SearchByImageInput,
    UpdateMetadataInput,
    UploadAssetInput,
)
from verity_dam_mcp.audit import AuditMiddleware
from verity_dam_mcp.governance import ToolGovernanceMiddleware
from verity_dam_mcp.settings import McpSettings

settings = McpSettings.from_environment()
bot_session = BotSession(settings)
gateway = MediaMcpGateway(settings, bot_session)

server = MCPServer(
    "verity_dam_mcp",
    version="0.1.0",
    # Audit is outermost so governance denials are logged too.
    middleware=[AuditMiddleware(gateway), ToolGovernanceMiddleware(gateway)],
    instructions=(
        "Search, read, add, and edit VerityDAM's image library. Every write here is attributed to a "
        "dedicated reviewer-role bot account, exactly like a human reviewer's edit. Newly uploaded assets "
        "sit in 'pending' review until media_resolve_review_item approves them -- they will not show up "
        "in media_list_library or media_search_by_image before that. This server is a foundation: some "
        "capabilities the human web app has (multi-select filters, AI-derived flags, usage tracking) are "
        "not exposed yet; see docs/mcp-server.md for what's covered and what's follow-up work. "
        "The canonical web app for human review is https://dam.verity.internal. "
        "Public media images are served via CDN from https://assets.verity.internal without hotlink or expiry restrictions."
    ),
)


def _sign_rows(rows: list[dict]) -> dict[str, str]:
    """Best-effort signed-URL lookup; degrades to empty thumbnails on failure."""
    paths: list[str] = []
    for row in rows:
        if row.get("storage_path"):
            paths.append(row["storage_path"])
        if row.get("thumbnail_path"):
            paths.append(row["thumbnail_path"])
    try:
        return gateway.create_signed_urls(paths)
    except GatewayError:
        return {}


def _sanitize_filename(filename: str) -> str:
    name = filename.strip().replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name[:150] or "upload.bin"


def _vector_literal(values: list[float]) -> str:
    return "[" + ",".join(format(value, ".9g") for value in values) + "]"


@server.tool(
    annotations=ToolAnnotations(
        title="Browse or text-search the media library",
        read_only_hint=True,
        idempotent_hint=True,
        open_world_hint=True,
    )
)
def media_list_library(params: ListLibraryInput) -> str:
    """Browse or free-text search approved media assets, with optional exact-match filters.

    When `query` is given: runs Vietnamese-aware deterministic ranking (exact entity,
    lexical, bounded fuzzy) over an SQL-authorized candidate pool, then paginates the
    ranked results. Without `query`: returns the most-recent approved assets matching
    the structural filters — no ranking cost.

    Only ever returns review_state='approved' and non-deleted assets by default.
    Admins may set include_deleted for recovery/audit. Use media_list_pending_review
    to see items awaiting a decision. For pixel-level similarity use
    media_search_by_image instead: this tool only matches text fields, never pixels.
    """
    # Structural filters applied in both paths.
    filters: dict[str, str | None] = {
        "category": params.category or None,
        "space": params.space or None,
        "status": params.status or None,
        "permission": params.permission or None,
        "media_type": params.media_type or None,
    }

    try:
        if params.query:
            # Ranked path: SQL retrieval → in-process deterministic ranking → paginate.
            synonyms = gateway.reviewed_synonyms()
            terms = build_retrieval_terms(params.query, synonyms)
            candidates = gateway.search_media_assets(
                terms,
                filters,
                include_deleted=params.include_deleted,
                include_reported=params.include_reported,
                include_unfinished=params.include_unfinished,
            )
            page = rank_library_rows(
                params.query,
                candidates,
                limit=params.limit,
                offset=params.offset,
            )
            rows = list(page.rows)
        else:
            # Fast browse path: no ranking, just filter + recency sort.
            query_params: dict[str, str] = {
                "review_state": "eq.approved",
                "select": "*",
                "order": "created_at.desc",
                "limit": str(params.limit),
                "offset": str(params.offset),
            }
            if params.include_deleted:
                query_params["include_deleted"] = "true"
            if params.include_reported:
                query_params["include_reported"] = "true"
            if params.include_unfinished:
                query_params["include_unfinished"] = "true"
            for field, value in filters.items():
                if value:
                    query_params[field] = f"eq.{value}"
            rows = gateway.select("media_assets", query_params)
    except GatewayError as error:
        return f"Error listing media: {error}"

    signed_urls = _sign_rows(rows)
    assets = [format_media_asset(row, signed_urls) for row in rows]
    if params.response_format == "json":
        return render_json(assets)
    return render_assets_markdown(assets, "Media library results", "No approved assets matched these filters.")


@server.tool(
    annotations=ToolAnnotations(
        title="Search the library by visual similarity",
        read_only_hint=True,
        idempotent_hint=False,
        open_world_hint=True,
    )
)
def media_search_by_image(params: SearchByImageInput) -> str:
    """Rank approved media assets by visual similarity to a query image or an existing asset.

    Give either `media_asset_id` (reuse that asset's own stored embedding) or `image_base64`
    (embed fresh bytes) -- not both. Uses the active production embedding space, the
    same one scene-duplicate and SKU matching use, so results are only as good as that
    asset's own embedding: an asset still waiting on the background worker to embed it has
    no vector yet and cannot be used as a query.
    """
    try:
        active_space_id = gateway.space_resolver.get_active_space_id()
        if params.media_asset_id:
            rows = gateway.select(
                "asset_embeddings",
                {
                    "asset_id": f"eq.{params.media_asset_id}",
                    "space_id": f"eq.{active_space_id}",
                    "kind": "eq.global",
                    "limit": "1",
                },
            )
            if not rows:
                asset_rows = gateway.select("media_assets", {"id": f"eq.{params.media_asset_id}", "limit": "1"})
                if not asset_rows:
                    return f"Error: media asset {params.media_asset_id} was not found or is not visible to this account."
                return (
                    f"Error: media asset {params.media_asset_id} has no embedding yet -- it may still be "
                    "pending background processing, or it predates the production embedding migration."
                )
            raw_vector = rows[0].get("vector")
            if not isinstance(raw_vector, str) or not raw_vector:
                return (
                    f"Error: media asset {params.media_asset_id} has no embedding yet -- it may still be "
                    "pending background processing, or it predates the production embedding migration."
                )
            vector_literal = raw_vector
        else:
            try:
                payload = base64.b64decode(params.image_base64, validate=True)  # type: ignore[arg-type]
            except (binascii.Error, ValueError):
                return "Error: image_base64 is not valid base64 data."
            if not payload:
                return "Error: decoded image is empty."
            vector_literal = _vector_literal(
                embedding.embed_image_bytes(
                    payload,
                    space_id=active_space_id,
                    siglip2_model_path=settings.siglip2_vision_model_path,
                    openclip_model_path=settings.openclip_vision_model_path,
                )
            )
    except (GatewayError, ConfigurationError, EmbeddingApiError) as error:
        return f"Error preparing the image query: {error}"

    try:
        matches = gateway.rpc(
            "match_media_assets_by_image_embedding",
            {
                "p_embedding": vector_literal,
                "p_match_count": params.match_count,
                "p_min_similarity": params.min_similarity,
                "p_public_only": params.public_only,
                "p_space_id": active_space_id,
            },
        )
    except GatewayError as error:
        return f"Error running the similarity search: {error}."
    if not isinstance(matches, list) or not matches:
        return "No approved assets matched above the similarity floor. Try lowering min_similarity."

    similarity_by_id = {m["media_asset_id"]: m.get("similarity") for m in matches if isinstance(m, dict)}
    ids = list(similarity_by_id)
    try:
        rows = gateway.select("media_assets", {"id": f"in.({','.join(ids)})", "select": "*"})
    except GatewayError as error:
        return f"Error fetching matched assets: {error}"

    signed_urls = _sign_rows(rows)
    assets = []
    for row in rows:
        asset = format_media_asset(row, signed_urls)
        asset["similarity"] = similarity_by_id.get(row.get("id"))
        assets.append(asset)
    assets.sort(key=lambda a: a.get("similarity") or 0, reverse=True)

    if params.response_format == "json":
        return render_json(assets)
    return render_assets_markdown(assets, "Visually similar assets", "No approved assets matched.")


@server.tool(
    annotations=ToolAnnotations(
        title="Get one media asset's full details",
        read_only_hint=True,
        idempotent_hint=True,
        open_world_hint=True,
    )
)
def media_get_asset(params: GetAssetInput) -> str:
    """Fetch one media asset's full metadata, signed file/thumbnail URLs, and crop configs.

    Works for any review_state the account can see: an approved asset is visible to any
    member, while a pending or rejected one is only visible to a reviewer/admin -- the same
     server-side reviewer authorization used by the web app's review queue.
    """
    try:
        select_params = {"id": f"eq.{params.media_asset_id}", "select": "*", "limit": "1"}
        if params.include_deleted:
            select_params["include_deleted"] = "true"
        rows = gateway.select("media_assets", select_params)
    except GatewayError as error:
        return f"Error fetching media asset: {error}"
    if not rows:
        return (
            f"Error: media asset {params.media_asset_id} was not found, or this account's role cannot see it "
            "(a pending or rejected asset requires the reviewer role)."
        )
    signed_urls = _sign_rows(rows)
    asset = format_media_asset(rows[0], signed_urls)
    if params.response_format == "json":
        return render_json(asset)
    return render_assets_markdown([asset], "Media asset", "")


@server.tool(
    annotations=ToolAnnotations(
        title="List assets awaiting a review decision",
        read_only_hint=True,
        idempotent_hint=True,
        open_world_hint=True,
    )
)
def media_list_pending_review(params: ListPendingReviewInput) -> str:
    """List review_queue items still in 'pending' status, oldest first, with their draft metadata.

    Requires the reviewer role (the same server-side authorization gates review_queue reads for non-approved
    context). Pair with media_resolve_review_item to act on what this returns.
    """
    try:
        rows = gateway.select(
            "review_queue",
            {
                "status": "eq.pending",
                "select": "id,media_asset_id,status,metadata_draft,is_duplicate,duplicate_asset_ids,created_at,media_assets(*)",
                "order": "created_at.asc",
                "limit": str(params.limit),
                "offset": str(params.offset),
            },
        )
    except GatewayError as error:
        return f"Error listing the review queue: {error}"
    if not rows:
        return "The review queue is empty."

    asset_rows = [row.get("media_assets") or {} for row in rows]
    signed_urls = _sign_rows(asset_rows)
    assets = []
    for row, asset_row in zip(rows, asset_rows):
        asset = format_media_asset(asset_row, signed_urls)
        asset["review_queue_id"] = row.get("id")
        asset["is_duplicate"] = row.get("is_duplicate")
        asset["duplicate_asset_ids"] = row.get("duplicate_asset_ids")
        asset["metadata_draft"] = row.get("metadata_draft")
        assets.append(asset)

    if params.response_format == "json":
        return render_json(assets)
    return render_assets_markdown(assets, "Pending review queue", "The review queue is empty.")


@server.tool(
    annotations=ToolAnnotations(
        title="Upload a new image for review",
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=False,
        open_world_hint=True,
    )
)
def media_upload_asset(params: UploadAssetInput) -> str:
    """Upload raw image bytes into Storage and register them as a new, pending media asset.

    The asset lands in 'pending' review state -- it will not appear in media_list_library or
    media_search_by_image until media_resolve_review_item approves it. Vision metadata,
    dimensions, and the visual embedding are filled in afterwards by the background worker,
    not by this call, so media_get_asset may show them empty for a short while after upload.

    The server hashes the decoded bytes (SHA-256) and refuses exact duplicates: if a non-deleted
    asset with identical bytes exists, nothing is stored and the response is
    "Upload skipped (exact duplicate)" with `duplicate_of_media_asset_id`. Pass `sha256` to have a
    mismatch rejected, and `source_ref` to record a per-file origin id on origin_info.
    """
    max_bytes = 200 * 1024 * 1024 if params.media_type == "video" else 50 * 1024 * 1024
    # Reject oversized base64 before decoding so an MCP caller cannot force a
    # large transient allocation in the process.
    if len(params.image_base64) > ((max_bytes + 2) // 3) * 4 + 4:
        return "Error: upload exceeds the allowed media size."
    try:
        payload = base64.b64decode(params.image_base64, validate=True)
    except (binascii.Error, ValueError):
        return "Error: image_base64 is not valid base64 data."
    if not payload or len(payload) > max_bytes:
        return "Error: decoded image is empty."

    content_sha256 = hashlib.sha256(payload).hexdigest()
    if params.sha256 and params.sha256.lower() != content_sha256:
        return (
            "Error: sha256 does not match the decoded file bytes "
            f"(server computed {content_sha256}). Re-hash the exact bytes you are sending."
        )

    safe_filename = _sanitize_filename(params.filename)
    try:
        user_id = gateway.user_id()
        duplicate = gateway.find_asset_by_content_hash(content_sha256)
    except GatewayError as error:
        return f"Error resolving the MCP bot account: {error}"

    if duplicate:
        lines = [
            "## Upload skipped (exact duplicate)",
            "",
            f"- duplicate_of_media_asset_id: `{duplicate.get('id')}`",
            f"- review_state: {duplicate.get('review_state')}",
        ]
        if duplicate.get("review_queue_id"):
            lines.append(f"- review_queue_id: `{duplicate.get('review_queue_id')}`")
        lines.append(f"- sha256: `{content_sha256}`")
        lines.append("")
        lines.append("An asset with identical file bytes already exists, so nothing was stored.")
        return "\n".join(lines)

    now = datetime.now(timezone.utc)
    storage_path = f"{user_id}/{now:%Y}/{now:%m}/{uuid.uuid4()}-{safe_filename}"

    try:
        gateway.upload_object(storage_path, payload, safe_filename)
        result = gateway.rpc(
            "finalize_upload_batch",
            {
                "p_uploads": [
                    {
                        "storage_path": storage_path,
                        "file_name": safe_filename,
                        "media_type": params.media_type,
                        "permission": params.permission,
                        "sha256": content_sha256,
                        "source_ref": params.source_ref,
                    }
                ],
                "p_context": params.context,
            },
        )
    except GatewayError as error:
        return f"Error uploading asset: {error}"

    row = result[0] if isinstance(result, list) and result else None
    if not row:
        return "Error: upload finalized but returned no result row."

    lines = [
        "## Upload accepted (pending review)",
        "",
        f"- media_asset_id: `{row.get('media_asset_id')}`",
        f"- review_queue_id: `{row.get('review_queue_id')}`",
        f"- sha256: `{content_sha256}`",
    ]
    if row.get("is_duplicate"):
        lines.append(f"- ⚠ flagged as a possible duplicate of: {row.get('duplicate_asset_ids')}")
    lines.append("")
    lines.append("Call media_resolve_review_item with this review_queue_id to approve or reject it.")
    return "\n".join(lines)


@server.tool(
    annotations=ToolAnnotations(
        title="Approve or reject a pending review item",
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=False,
        open_world_hint=True,
    )
)
def media_resolve_review_item(params: ResolveReviewItemInput) -> str:
    """Approve or reject one pending review_queue item, optionally patching its metadata.

    Requires the reviewer role. Only works while the item is still 'pending' -- once decided,
    use media_update_metadata (approved) for further edits. Marking a `patch` field true in
    `corrections` records it as a correction of the AI's own draft, feeding the same
    few-shot training loop a human reviewer's corrections do.
    """
    try:
        result = gateway.rpc(
            "resolve_review_item",
            {
                "p_review_queue_id": params.review_queue_id,
                "p_decision": params.decision,
                "p_patch": params.patch,
                "p_corrections": params.corrections,
            },
        )
    except GatewayError as error:
        return f"Error resolving review item: {error}"
    row = result[0] if isinstance(result, list) and result else None
    if not row:
        return "Error: resolve_review_item returned no result row."
    return (
        "## Review item resolved\n\n"
        f"- media_asset_id: `{row.get('media_asset_id')}`\n"
        f"- review_queue_id: `{row.get('review_queue_id')}`\n"
        f"- review_status: {row.get('review_status')}\n"
    )


@server.tool(
    annotations=ToolAnnotations(
        title="Edit metadata on an already-decided asset",
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=True,
    )
)
def media_update_metadata(params: UpdateMetadataInput) -> str:
    """Patch title/brand/category/description/etc. on an asset that is no longer pending.

    Requires the reviewer role. Rejects sku changes (route those through
    media_resolve_review_item while the item is pending) and rejects the call outright while
    the asset is still pending -- use media_resolve_review_item for that stage instead.
    """
    try:
        result = gateway.rpc(
            "update_media_asset_metadata",
            {"p_media_asset_id": params.media_asset_id, "p_patch": params.patch},
        )
    except GatewayError as error:
        return f"Error updating metadata: {error}."
    row = result[0] if isinstance(result, list) and result else None
    if not row:
        return "Error: update_media_asset_metadata returned no result row."
    updated = row.get("updated_fields") or []
    if not updated:
        return "No fields changed -- the patch matched the asset's current values."
    return (
        "## Metadata updated\n\n"
        f"- media_asset_id: `{row.get('media_asset_id')}`\n"
        f"- review_queue_id: `{row.get('review_queue_id')}`\n"
        f"- updated_fields: {', '.join(updated)}\n"
    )


@server.tool(
    annotations=ToolAnnotations(
        title="Save a crop rectangle for one aspect-ratio preset",
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=True,
    )
)
def media_save_crop(params: SaveCropInput) -> str:
    """Persist a pixel-space crop rectangle for one aspect-ratio preset on a media asset.

    Requires the reviewer role. `crop` bounds are validated against the asset's stored
    natural dimensions when known.
    """
    try:
        result = gateway.rpc(
            "save_media_crop_config",
            {
                "p_media_asset_id": params.media_asset_id,
                "p_preset_id": params.preset_id,
                "p_crop": params.crop,
                "p_updated_by": "verity-media-mcp-agent",
            },
        )
    except GatewayError as error:
        return f"Error saving crop: {error}"
    preview_url = f"https://dam.verity.internal/library?asset={params.media_asset_id}"
    return render_json(result) + f"\n\nCrop saved. Preview at: {preview_url}"


# ==============================================================================
# media_search — Unified natural-language search (Phase 3B / Issue #51)
# ==============================================================================

_MEDIA_SEARCH_TIMEOUT = 30.0  # seconds; keeps tool calls bounded


def _run_media_search(params: MediaSearchInput) -> MediaSearchOutput:
    actor_user_id = gateway.user_id()
    endpoint = f"{settings.next_api_base_url}/api/internal/media-search"

    payload = params.model_dump(exclude_none=True)

    try:
        response = httpx.post(
            endpoint,
            json=payload,
            headers={
                "x-internal-service-key": settings.internal_service_key,
                "x-actor-user-id": actor_user_id,
                "Content-Type": "application/json",
            },
            timeout=_MEDIA_SEARCH_TIMEOUT,
        )
        response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise GatewayError(f"media_search timed out after {_MEDIA_SEARCH_TIMEOUT:.0f}s") from exc
    except httpx.HTTPStatusError as exc:
        raise GatewayError(f"upstream search returned HTTP {exc.response.status_code}: {exc.response.text[:200]}") from exc
    except httpx.RequestError as exc:
        raise GatewayError(f"could not reach internal search endpoint ({exc})") from exc

    try:
        data = response.json()
        output = MediaSearchOutput(**data)
    except Exception as exc:  # noqa: BLE001 — surface parse errors clearly
        raise GatewayError(f"failed to parse search response: {exc}") from exc

    # Rewrite relative proxy URLs (/api/r2-proxy?key=...) to absolute URLs
    _base = settings.public_base_url.rstrip("/")
    for item in output.results:
        if item.thumbnail_url and item.thumbnail_url.startswith("/"):
            item.thumbnail_url = f"{_base}{item.thumbnail_url}"
        if item.file_url and item.file_url.startswith("/"):
            item.file_url = f"{_base}{item.file_url}"
        # ``cdn_url`` is a trust boundary: only the internal route may mark a
        # version-verified WordPress rendition as canonical.  Do not turn a
        # relative path or arbitrary upstream URL into a publishing URL here.
        if item.cdn_url and re.match(r"^https://[^/]+/wp-content/uploads/", item.cdn_url):
            # ``file_url`` was the original public contract. Keep old
            # consumers safe by preferring the verified rendition.
            item.file_url = item.cdn_url
            item.thumbnail_url = item.cdn_url
        else:
            item.cdn_url = None

    return output


@server.tool(
    annotations=ToolAnnotations(
        title="Search Media Library (NLP)",
        read_only_hint=True,
        destructive_hint=False,
    )
)
def media_search(params: MediaSearchInput) -> MediaSearchOutput:
    """Search the Verity media library with a natural-language query.

    Proxies to the canonical Next.js internal search endpoint so that
    all ranking, permission enforcement, semantic expansion, canary routing,
    and MMR diversification happen in one place. This tool is a pure proxy —
    no ranking logic runs here.

    Returns a structured MediaSearchOutput object with outputSchema.
    """
    output = _run_media_search(params)

    # Populate concise markdown summary
    lines: list[str] = [
        f'## Search results for "{output.query}" ({output.returned}/{output.total})\n'
    ]
    for idx, item in enumerate(output.results, 1):
        skus = ", ".join(m.code for m in item.canonical_sku_matches) or "—"
        reasons = ", ".join(item.match_reasons) or "—"
        lines.append(
            f"**{idx}. {item.title}** (score: {item.score:.3f})\n"
            f"  - Asset ID: `{item.asset_id}`\n"
            f"  - Permission: {item.permission} | Status: {item.status or '—'}\n"
            f"  - SKUs matched: {skus}\n"
            f"  - Match reasons: {reasons}\n"
            f"  - Product-safe: {item.product_safety.safe_for_exact_product_use}\n"
            + ("  - ⚠️ REPORTED: Asset has an open issue report\n" if item.has_open_report else "")
            + ("  - 🛠 needs post-production: raw/unfinished, do not use for external publish without review\n" if item.needs_post_production else "")
            + (f"  - Description: {item.description}\n" if item.description else "")
            + (f"  - Canonical CDN URL: {item.cdn_url}\n" if item.cdn_url else "")
            + (f"  - Dimensions: {item.width}×{item.height}\n" if item.width and item.height else "")
            + (f"  - Thumbnail: {item.thumbnail_url}\n" if item.thumbnail_url else "")
        )
    meta = output.search_meta
    lines.append(
        f"\n*Semantic: {meta.semantic_active} | "
        f"Recovery: {meta.recovery_stage or 'none'} | "
        f"Actor role: {meta.actor_role}*"
    )
    output.markdown_summary = _truncate("\n".join(lines))

    return output


# ==============================================================================
# media_get_usage_history — Asset usage & publication records
# ==============================================================================


@server.tool(
    annotations=ToolAnnotations(
        title="Get Media Usage History",
        read_only_hint=True,
        destructive_hint=False,
    )
)
def media_get_usage_history(params: MediaUsageHistoryInput) -> MediaUsageHistoryOutput:
    """Retrieve publication and usage history for an asset across channels.

    Returns channel records (Facebook, website, CRM, Zalo, etc.) where this asset
    has been deployed. Returns empty list if no usages have been recorded yet.
    """
    target_id = params.media_asset_id or params.asset_id or ""
    usages_raw = gateway.fetch_usage_history(target_id, limit=params.limit)
    items = [MediaUsageItem(**u) for u in usages_raw]
    return MediaUsageHistoryOutput(
        asset_id=target_id,
        media_asset_id=target_id,
        total=len(items),
        usages=items,
    )


# ==============================================================================
# media_record_usage — Record that an asset was used in a marketing channel
# ==============================================================================


@server.tool(
    annotations=ToolAnnotations(
        title="Record Media Asset Usage",
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=False,
    )
)
def media_record_usage(params: RecordUsageInput) -> RecordUsageOutput:
    """Record that a media asset was deployed to a marketing channel.

    Call this immediately after you publish or embed an asset so the usage
    is traceable. Requires the bot account to have at minimum 'contributor' role.

    The asset must already be approved -- recording usage against a pending or
    deleted asset is rejected to prevent phantom audit trails. Usage is also
    refused if the asset has an open issue report (unconditionally -- resolve
    the report first) or is flagged needs_post_production (reviewer/admin may
    override with allow_unfinished=true when there's a real reason it's fine
    for this specific channel).

    Common channel slugs: 'facebook', 'zalo', 'website', 'google_shopping',
    'email', 'crm', 'tiktok', 'instagram', 'youtube', 'print'.

    Example workflow:
        1. media_search(query="...", permission="public")      → pick asset_id
        2. ... publish the image externally ...
        3. media_record_usage(media_asset_id=asset_id,         → audit trail ✓
                              channel="facebook",
                              note="Summer 2026 campaign - post #123")
        4. media_get_usage_history(asset_id=asset_id)          → confirm
    """
    result = gateway.record_usage(
        asset_id=params.media_asset_id,
        channel=params.channel,
        note=params.note,
        allow_unfinished=params.allow_unfinished,
    )
    return RecordUsageOutput(**result)


# ==============================================================================
# media_evaluate_image_fit — Evaluate image relevance against article/post text
# ==============================================================================


@server.tool(
    annotations=ToolAnnotations(
        title="Evaluate Image Fit",
        read_only_hint=True,
        destructive_hint=False,
    )
)
def media_evaluate_image_fit(params: EvaluateImageFitInput) -> EvaluateImageFitOutput:
    """Evaluate how well an image fits an article or social media post.

    Uses Vision LLM, channel technical specs, confirmed SKU matches, and recent
    usage history to grade fit on the standard 0-3 scale:
      - Grade 3 (Ideal): Exact product match, optimal scene, proper aspect ratio.
      - Grade 2 (Highly Relevant): Conceptually matches or acceptable lifestyle context.
      - Grade 1 (Marginally Relevant): Weak connection, wrong SKU/model, or peripheral subject.
      - Grade 0 (Irrelevant / Unsafe): Complete mismatch, hallucination, or constraint breach.

    Provide either 'media_asset_id' (existing DAM asset) or 'image_base64' (new image bytes).
    """
    return evaluate_image_fit(gateway, settings, params)


# ==============================================================================
# media_find_best_image_for_post — Search, score, and select the best image for a post
# ==============================================================================


@server.tool(
    annotations=ToolAnnotations(
        title="Find Best Image for Post",
        read_only_hint=True,
        destructive_hint=False,
    )
)
def media_find_best_image_for_post(params: FindBestImageInput) -> FindBestImageOutput:
    """Find, evaluate, and recommend the best image from the library for a post or article.

    Automates the candidate search -> image-fit evaluation -> deduplication -> ranking pipeline:
      1. Derives an effective search query from post_text and product_hint if search_query is omitted.
      2. Retrieves top candidate assets via semantic + lexical search.
      3. Evaluates each candidate's image fit (0-3 grade, SKU verification, aspect ratio suitability).
      4. Checks 14-day usage history on the target channel to prevent duplicate posting.
      5. Returns the top qualifying candidate as 'best_pick', plus all ranked candidates.
    """
    return find_best_image(gateway, settings, _run_media_search, params)
