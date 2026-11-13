import json
from typing import Any, Callable

CHARACTER_LIMIT = 25_000
_JSON_ENVELOPE_OVERHEAD = 200


def to_thumbnail_url(public_url: str, width: int = 400, quality: int = 75) -> str:
    """Return the public CDN URL as-is.

    Cloudflare Image Resizing (/cdn-cgi/image/...) requires a paid plan feature
    NOT currently enabled on assets.verity.internal -- rewriting to that endpoint returns
    404.  The TS media-mapper.ts also does not apply this transformation.
    Signature is kept so callers need no changes when Image Resizing is enabled.
    """
    return public_url or ""


def format_media_asset(row: dict[str, Any], signed_urls: dict[str, str] | None = None) -> dict[str, Any]:
    """Shape one ``media_assets`` row into the agent-facing contract."""

    signed_urls = signed_urls or {}
    storage_path = row.get("storage_path") or None
    thumbnail_path = row.get("thumbnail_path") or None
    cdn_key = str(row.get("cdn_key") or "")
    cdn_url = str(row.get("cdn_url") or "")
    row_file_url = str(row.get("file_url") or "")
    row_thumb_url = str(row.get("thumbnail_url") or "")
    canonical_version = int(row.get("canonical_version") or 0)
    published_version = int(row.get("canonical_published_version") or 0)
    canonical_url = (
        cdn_url
        if cdn_key.startswith("wp-content/uploads/")
        and cdn_url.startswith("https://")
        and canonical_version > 0
        and canonical_version == published_version
        else ""
    )

    # Permanent public CDN URL (no signature query, no expiry, Facebook/crawler friendly)
    public_cdn_base = "https://assets.verity.internal"
    permanent_file_url = ""
    if row_file_url.startswith("https://assets.verity.internal/"):
        permanent_file_url = row_file_url
    elif storage_path:
        permanent_file_url = f"{public_cdn_base}/{storage_path.lstrip('/')}"

    permanent_thumb_url = ""
    if row_thumb_url.startswith("https://assets.verity.internal/"):
        permanent_thumb_url = row_thumb_url
    elif thumbnail_path:
        permanent_thumb_url = f"{public_cdn_base}/{thumbnail_path.lstrip('/')}"
    elif permanent_file_url:
        permanent_thumb_url = permanent_file_url

    file_url = canonical_url or permanent_file_url or (signed_urls.get(storage_path, "") if storage_path else "")
    raw_thumb = ""
    if thumbnail_path:
        raw_thumb = canonical_url or permanent_thumb_url or signed_urls.get(thumbnail_path) or signed_urls.get(storage_path, "")
    elif storage_path:
        raw_thumb = canonical_url or permanent_file_url or signed_urls.get(storage_path, "")
    keywords = row.get("keywords")
    return {
        "id": row.get("id"),
        "title": row.get("title") or "",
        "file_url": file_url,
        "thumbnail_url": to_thumbnail_url(raw_thumb) if raw_thumb else "",
        "media_type": row.get("media_type") or "image",
        "sku": row.get("sku") or "",
        "brand": row.get("brand") or "",
        "category": row.get("category") or "",
        "space": row.get("space") or None,
        "status": row.get("status") or "",
        "permission": row.get("permission") or "internal",
        "review_state": row.get("review_state") or "",
        "ai_confidence": row.get("ai_confidence"),
        "suggested_caption": row.get("suggested_caption") or None,
        "author": row.get("author") or "",
        "copyright": row.get("copyright") or "",
        "credit": row.get("credit") or "",
        "description": row.get("description") or "",
        "keywords": [value for value in keywords if isinstance(value, str)] if isinstance(keywords, list) else [],
        "dimensions": row.get("dimensions") if isinstance(row.get("dimensions"), dict) else None,
        "crop_configs": (row.get("origin_info") or {}).get("crop_configs")
        if isinstance(row.get("origin_info"), dict)
        else None,
        "created_at": row.get("created_at") or "",
        "updated_at": row.get("updated_at") or None,
        "cdn_key": cdn_key or None,
        "cdn_url": canonical_url or None,
        "canonical_slug": row.get("canonical_slug") or None,
        "has_open_report": bool(row.get("has_open_report", False)),
        "needs_post_production": bool(row.get("needs_post_production", False)),
        "search": row.get("_search") if isinstance(row.get("_search"), dict) else None,
    }


def _truncate_list(
    items: list[Any],
    render_item: Callable[[Any], str],
    limit: int,
    sep_overhead: int = 4,
) -> tuple[list[Any], bool]:
    """Return the largest prefix of ``items`` whose rendered lengths fit under ``limit``.

    ``sep_overhead`` is a per-item allowance for separator/formatting bytes added when the
    prefix is re-serialized as part of a larger structure. This is a coarse, fast estimate
    (O(n), one render per item) -- callers that embed the prefix in a further-formatted
    envelope (e.g. indented JSON) should still verify the final assembled length themselves,
    since indentation depth can shift the true size slightly.
    """
    total = 0
    prefix: list[Any] = []
    for item in items:
        item_len = len(render_item(item)) + sep_overhead
        if total + item_len > limit:
            return prefix, True
        total += item_len
        prefix.append(item)
    return prefix, False


def render_json(payload: Any) -> str:
    if isinstance(payload, list):
        full_text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        if len(full_text) <= CHARACTER_LIMIT:
            return full_text

        prefix, _ = _truncate_list(
            payload,
            lambda item: json.dumps(item, ensure_ascii=False, default=str),
            limit=CHARACTER_LIMIT - _JSON_ENVELOPE_OVERHEAD,
        )
        # Safety net: the coarse per-item estimate above doesn't account for the extra
        # indentation depth of nesting each item under "results" -- shrink further if the
        # assembled envelope still doesn't fit, so this can never emit invalid or
        # over-limit output regardless of how good the estimate was.
        while prefix:
            wrapped = json.dumps(
                {
                    "results": prefix,
                    "truncated": True,
                    "returned_count": len(prefix),
                    "total_candidate_count": len(payload),
                },
                ensure_ascii=False,
                indent=2,
                default=str,
            )
            if len(wrapped) <= CHARACTER_LIMIT or len(prefix) == 1:
                return wrapped
            prefix = prefix[: len(prefix) - 1]
        return json.dumps(
            {"results": [], "truncated": True, "returned_count": 0, "total_candidate_count": len(payload)},
            ensure_ascii=False,
        )

    text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    if len(text) <= CHARACTER_LIMIT:
        return text
    return json.dumps(
        {
            "truncated": True,
            "note": f"payload exceeds {CHARACTER_LIMIT} characters and is not a list; narrow the query",
        },
        ensure_ascii=False,
    )


def _render_asset_block(asset: dict[str, Any]) -> str:
    lines: list[str] = []
    similarity = asset.get("similarity")
    similarity_note = f" — similarity {similarity:.3f}" if isinstance(similarity, (int, float)) else ""
    search = asset.get("search") if isinstance(asset.get("search"), dict) else {}
    search_note = f" — rank {search.get('rank')} · {search.get('tier')}" if search.get("rank") is not None else ""
    lines.append(f"### {asset.get('title') or '(untitled)'}{similarity_note}{search_note}")
    lines.append(f"- id: `{asset.get('id')}`")
    if asset.get("review_queue_id"):
        lines.append(f"- review_queue_id: `{asset['review_queue_id']}`")
    lines.append(
        f"- sku: `{asset.get('sku') or '—'}` · brand: {asset.get('brand') or '—'} · "
        f"category: {asset.get('category') or '—'} · space: {asset.get('space') or '—'}"
    )
    lines.append(
        f"- status: {asset.get('status') or '—'} · permission: {asset.get('permission') or '—'} · "
        f"review_state: {asset.get('review_state') or '—'}"
    )
    if search:
        lines.append(
            f"- search_score: {search.get('score')} · lexical_rank: {search.get('lexical_rank') or '—'}"
        )
    if asset.get("is_duplicate"):
        lines.append(f"- ⚠ flagged as a possible duplicate: {asset.get('duplicate_asset_ids')}")
    if asset.get("has_open_report"):
        lines.append("- ⚠ REPORTED: Asset has an open issue report")
    if asset.get("needs_post_production"):
        lines.append("- 🛠 needs post-production: raw/unfinished, do not use for external publish without review")
    if asset.get("dimensions"):
        dims = asset["dimensions"]
        lines.append(f"- dimensions: {dims.get('width')}x{dims.get('height')} ({dims.get('size_bytes')} bytes)")
    if asset.get("crop_configs"):
        lines.append(f"- crop_configs: {json.dumps(asset['crop_configs'], ensure_ascii=False)}")
    if asset.get("file_url"):
        lines.append(f"- file_url: {asset['file_url']}")
    if asset.get("thumbnail_url"):
        lines.append(f"- thumbnail: {asset['thumbnail_url']}")
    if asset.get("description"):
        lines.append(f"- description: {asset['description']}")
    if asset.get("keywords"):
        lines.append(f"- keywords: {', '.join(asset['keywords'])}")
    if asset.get("metadata_draft"):
        draft = json.dumps(asset["metadata_draft"], ensure_ascii=False, default=str)
        lines.append(f"- AI-drafted metadata awaiting review: {draft}")
    lines.append("")
    return "\n".join(lines) + "\n"


def render_assets_markdown(assets: list[dict[str, Any]], heading: str, empty_message: str) -> str:
    if not assets:
        return f"## {heading}\n\n{empty_message}\n"

    header_text = f"## {heading} ({len(assets)})\n\n"
    blocks = [_render_asset_block(asset) for asset in assets]
    full_text = header_text + "".join(blocks)
    if len(full_text) <= CHARACTER_LIMIT:
        return full_text

    body = ""
    included = 0
    for block in blocks:
        candidate = body + block
        if len(header_text) + len(candidate) > CHARACTER_LIMIT:
            break
        body = candidate
        included += 1
    note = f"\n... [truncated after {included} of {len(assets)} results; narrow the query or use pagination]\n"
    return header_text + body + note


def _truncate(text: str, limit: int = CHARACTER_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n... [truncated at {limit} characters; narrow the query or use pagination]"
