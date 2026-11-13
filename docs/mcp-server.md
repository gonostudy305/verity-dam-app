# VerityDAM MCP Server

The production MCP endpoint is `https://dam.verity.internal/mcp`. It exposes the
VerityDAM library to authenticated agents using the native PostgreSQL and R2
runtime. The detailed client setup, RBAC matrix, and tool catalog live in
`.agents/skills/verity-media-mcp/`.

## `media_search` publishing URLs

`media_search` returns a structured `MediaSearchOutput`. Each result can
contain these URL and size fields:

- `cdn_url`: the preferred public URL for WordPress, web, or social publishing.
  It is present only when the asset has a HTTPS WordPress rendition under
  `wp-content/uploads/` whose `canonical_version` matches
  `canonical_published_version`.
- `file_url`: the compatible primary read URL. It equals `cdn_url` when a
  verified canonical rendition exists; otherwise it can be a protected storage
  or application-proxy URL.
- `thumbnail_url`: the image preview URL. It also uses the verified rendition
  when available, and may otherwise be a protected fallback.
- `width` and `height`: intrinsic pixel dimensions, or `null` when missing or
  invalid. Agents must not invent a size when either value is `null`.

Agents must use a returned `cdn_url` for publishing. Do not construct asset
hosts or WordPress paths from an object key. A missing `cdn_url` means the
asset is not yet eligible for canonical public publishing; use it only through
the returned read URL and send it through the normal review/publish workflow.

## Security boundary

The MCP server identifies itself to the internal search endpoint with an
internal service key and its configured Better Auth bot account. The endpoint
resolves the bot role from PostgreSQL; callers cannot assert a role in MCP
tool input. All writes are audited by the MCP audit middleware.
