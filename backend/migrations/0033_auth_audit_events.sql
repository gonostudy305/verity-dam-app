-- 0033_auth_audit_events.sql
-- Durable Better Auth login/logout audit ledger.
--
-- This table deliberately stores security-relevant request metadata only. It
-- must never receive passwords, session tokens, cookies, or API keys.

create table if not exists public.auth_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('login_success', 'login_failure', 'logout')),
  user_id uuid references public."user"(id) on delete set null,
  email text,
  session_id text,
  ip_address text,
  user_agent text,
  request_path text not null default '',
  failure_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint auth_audit_events_email_length check (email is null or length(email) <= 320),
  constraint auth_audit_events_session_id_length check (session_id is null or length(session_id) <= 256),
  constraint auth_audit_events_ip_length check (ip_address is null or length(ip_address) <= 128),
  constraint auth_audit_events_user_agent_length check (user_agent is null or length(user_agent) <= 1024),
  constraint auth_audit_events_request_path_length check (length(request_path) <= 256),
  constraint auth_audit_events_failure_code_length check (failure_code is null or length(failure_code) <= 128),
  constraint auth_audit_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists idx_auth_audit_events_created_at
  on public.auth_audit_events (created_at desc);

create index if not exists idx_auth_audit_events_type_created_at
  on public.auth_audit_events (event_type, created_at desc);

create index if not exists idx_auth_audit_events_user_created_at
  on public.auth_audit_events (user_id, created_at desc)
  where user_id is not null;

comment on table public.auth_audit_events is
  'Append-only security audit ledger for Better Auth login and logout events; never store credentials or session tokens.';

comment on column public.auth_audit_events.ip_address is
  'Request address resolved at the application edge; retain according to the company security/privacy policy.';

