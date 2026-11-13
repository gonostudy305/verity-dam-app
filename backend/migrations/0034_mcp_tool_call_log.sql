-- 0034_mcp_tool_call_log.sql
-- Append-only audit ledger for VerityDAM MCP tool call activity.
--
-- Distinct from media_usages (which records business-level asset deployments),
-- this table records the MCP server runtime activity: tool name, bot user,
-- sanitized parameter summaries, result summaries, duration, and status.
-- Large payloads (e.g. image base64, full articles) are strictly omitted or
-- truncated before insertion.

create table if not exists public.mcp_tool_call_log (
  id uuid primary key default gen_random_uuid(),
  tool_name text not null,
  bot_user_id uuid references public."user"(id) on delete set null,
  params_summary jsonb not null default '{}'::jsonb,
  result_summary jsonb not null default '{}'::jsonb,
  status text not null check (status in ('success', 'error')),
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now(),
  constraint mcp_tool_call_log_tool_name_length check (length(tool_name) <= 128),
  constraint mcp_tool_call_log_error_message_length check (error_message is null or length(error_message) <= 2000),
  constraint mcp_tool_call_log_duration_nonnegative check (duration_ms is null or duration_ms >= 0),
  constraint mcp_tool_call_log_params_object check (jsonb_typeof(params_summary) = 'object'),
  constraint mcp_tool_call_log_result_object check (jsonb_typeof(result_summary) = 'object')
);

create index if not exists idx_mcp_tool_call_log_created_at
  on public.mcp_tool_call_log (created_at desc);

create index if not exists idx_mcp_tool_call_log_tool_created_at
  on public.mcp_tool_call_log (tool_name, created_at desc);

create index if not exists idx_mcp_tool_call_log_bot_user_created_at
  on public.mcp_tool_call_log (bot_user_id, created_at desc)
  where bot_user_id is not null;

comment on table public.mcp_tool_call_log is
  'Append-only operational audit ledger recording VerityDAM MCP tool calls by agents.';
comment on column public.mcp_tool_call_log.params_summary is
  'Sanitized JSON summary of input arguments (never stores raw image bytes or unbounded text).';
comment on column public.mcp_tool_call_log.result_summary is
  'High-level summary of tool output or error state.';
