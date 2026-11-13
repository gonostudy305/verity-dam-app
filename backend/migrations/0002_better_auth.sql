-- Better Auth PostgreSQL schema for the native VerityDAM runtime.
-- Better Auth's default field names are camelCase; keep them quoted so the
-- adapter can use its generated schema without a custom column mapper.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text not null unique,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public."user" (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  role text not null default 'viewer' check (role in ('viewer','contributor','reviewer','admin')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.session (
  id uuid primary key default gen_random_uuid(),
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid not null references public."user"(id) on delete cascade
);
create index if not exists idx_session_user_id on public.session ("userId");
create index if not exists idx_session_expires_at on public.session ("expiresAt");

create table if not exists public.account (
  id uuid primary key default gen_random_uuid(),
  issuer text not null default '',
  "accountId" text not null,
  "providerId" text not null,
  "userId" uuid not null references public."user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique (issuer, "accountId")
);
create index if not exists idx_account_user_id on public.account ("userId");

create table if not exists public.verification (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists idx_verification_identifier on public.verification (identifier);
create index if not exists idx_verification_expires_at on public.verification ("expiresAt");

create or replace function public.touch_better_auth_updated_at()
returns trigger language plpgsql as $$
begin
  new."updatedAt" = now();
  return new;
end;
$$;

drop trigger if exists trg_user_updated_at on public."user";
create trigger trg_user_updated_at before update on public."user"
for each row execute function public.touch_better_auth_updated_at();

create or replace function public.sync_native_auth_user()
returns trigger language plpgsql as $$
begin
  insert into auth.users (id, email, raw_app_meta_data, created_at, updated_at)
  values (new.id, new.email, jsonb_build_object('verity_media_role', new.role), new."createdAt", new."updatedAt")
  on conflict (id) do update set email = excluded.email,
    raw_app_meta_data = excluded.raw_app_meta_data, updated_at = excluded.updated_at;
  return new;
end;
$$;

drop trigger if exists trg_sync_native_auth_user on public."user";
create trigger trg_sync_native_auth_user after insert or update of email, role on public."user"
for each row execute function public.sync_native_auth_user();

create or replace function public.sync_native_auth_user_delete()
returns trigger language plpgsql as $$
begin
  delete from auth.users where id = old.id;
  return old;
end;
$$;

drop trigger if exists trg_sync_native_auth_user_delete on public."user";
create trigger trg_sync_native_auth_user_delete after delete on public."user"
for each row execute function public.sync_native_auth_user_delete();

drop trigger if exists trg_session_updated_at on public.session;
create trigger trg_session_updated_at before update on public.session
for each row execute function public.touch_better_auth_updated_at();
drop trigger if exists trg_account_updated_at on public.account;
create trigger trg_account_updated_at before update on public.account
for each row execute function public.touch_better_auth_updated_at();
drop trigger if exists trg_verification_updated_at on public.verification;
create trigger trg_verification_updated_at before update on public.verification
for each row execute function public.touch_better_auth_updated_at();
