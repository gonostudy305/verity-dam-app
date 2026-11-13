-- 0050_mcp_api_keys.sql
-- API Key ledger for VerityDAM MCP Server external access authorization.
--
-- Stores SHA-256 hashed secret keys, visible key prefix for identification,
-- role assignment (viewer, contributor, reviewer), and revocation timestamp.
-- Never stores raw secret keys in plaintext.

create table if not exists public.mcp_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public."user"(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  role text not null check (role in ('viewer', 'contributor', 'reviewer')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint mcp_api_keys_name_length check (length(name) <= 128),
  constraint mcp_api_keys_prefix_length check (length(key_prefix) <= 64),
  constraint mcp_api_keys_hash_length check (length(key_hash) = 64)
);

create index if not exists idx_mcp_api_keys_active_hash
  on public.mcp_api_keys (key_hash)
  where revoked_at is null;

create index if not exists idx_mcp_api_keys_user_id
  on public.mcp_api_keys (user_id);

comment on table public.mcp_api_keys is
  'External agent API keys for VerityDAM MCP Server HTTP Bearer authentication.';
comment on column public.mcp_api_keys.key_hash is
  'SHA-256 digest of the raw API token (verity_mcp_live_...). Raw token is never stored.';
comment on column public.mcp_api_keys.key_prefix is
  'Visible prefix for identification in settings UI (e.g. verity_mcp_live_9c2b...).';
comment on column public.mcp_api_keys.revoked_at is
  'Timestamp when key was soft-revoked. Non-null indicates inactive/blocked key.';

-- Seed the canonical Agenthub master key for mcp-agent@veritydam.example
-- Raw key: verity_mcp_live_9c2b4cf050e6ec32fd9db531457647d1957b1744b618bf73
insert into public.mcp_api_keys (user_id, name, key_prefix, key_hash, role)
select id, 'Agenthub Master Agent', 'verity_mcp_live_9c2b...', 'b4e711c950a9c1af9805a4b09349de1ae1f07ad8b947bc0fbf843fdacdbc7c9e', 'reviewer'
from public."user"
where lower(email) = 'mcp-agent@veritydam.example'
on conflict (key_hash) do nothing;
