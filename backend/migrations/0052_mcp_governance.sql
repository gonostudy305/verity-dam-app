-- 0052_mcp_governance.sql
-- Additive governance for the MCP server settings page.
--
-- 1. Revoke the Agenthub seed key from 0050: its raw token is written in that
--    migration's comments (committed to the repository), so it must be
--    treated as compromised. Matched by hash only; no-op if never seeded.
-- 2. API key lifecycle: optional expiry and rotation lineage.
-- 3. Per-key attribution in the MCP tool-call audit log.
-- 4. System-level enable/disable switch per MCP tool.

update public.mcp_api_keys
set revoked_at = now()
where key_hash = 'b4e711c950a9c1af9805a4b09349de1ae1f07ad8b947bc0fbf843fdacdbc7c9e'
  and revoked_at is null;

alter table public.mcp_api_keys
  add column if not exists expires_at timestamptz,
  add column if not exists rotated_from_id uuid references public.mcp_api_keys(id) on delete set null;

comment on column public.mcp_api_keys.expires_at is
  'Optional expiry. A key past expires_at is rejected by the MCP server like a revoked key.';
comment on column public.mcp_api_keys.rotated_from_id is
  'Key this one replaced through rotation (the old key is revoked in the same transaction).';

alter table public.mcp_tool_call_log
  add column if not exists api_key_id uuid references public.mcp_api_keys(id) on delete set null;

create index if not exists idx_mcp_tool_call_log_api_key_created_at
  on public.mcp_tool_call_log (api_key_id, created_at desc)
  where api_key_id is not null;

create table if not exists public.mcp_tool_settings (
  tool_name text primary key,
  enabled boolean not null default true,
  updated_by uuid references public."user"(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint mcp_tool_settings_tool_name_length check (length(tool_name) <= 128)
);

comment on table public.mcp_tool_settings is
  'Admin kill-switch per MCP tool. Missing row = enabled. Checked by the MCP server before each tools/call.';
