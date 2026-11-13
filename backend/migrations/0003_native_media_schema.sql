-- Native PostgreSQL runtime schema. This is the Supabase data plane expressed
-- as ordinary PostgreSQL tables; no PostgREST, Storage API, RLS or Supabase
-- service role is required by the application/worker after cutover.

create extension if not exists vector;
create extension if not exists pgcrypto;

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  file_url text not null default '',
  thumbnail_url text not null default '',
  guide_url text,
  storage_path text,
  thumbnail_path text,
  media_type text not null default 'photo' check (media_type in ('photo','video','render','screenshot')),
  duration text,
  sku text,
  brand text,
  category text,
  space text,
  status text not null default 'Mới',
  permission text not null default 'internal' check (permission in ('public','internal')),
  review_state text not null default 'pending' check (review_state in ('pending','approved','rejected')),
  ai_flags jsonb not null default '{"is_ai":false,"is_internal":false,"has_people":false,"tag_failed":false,"is_broken":false}'::jsonb,
  ai_confidence jsonb not null default '{}'::jsonb,
  suggested_caption text,
  author text not null default '',
  copyright text not null default '',
  credit text not null default '',
  description text not null default '',
  keywords text[] not null default '{}',
  phash text,
  embedding vector(1536),
  image_embedding vector(512),
  embedding_provider text,
  embedding_model text,
  embedding_version text,
  embedding_dimension integer,
  dimensions jsonb not null default '{}'::jsonb,
  origin_info jsonb not null default '{"source":"Upload"}'::jsonb,
  usage_count integer not null default 0,
  content_hash text,
  ingest_status text not null default 'queued' check (ingest_status in ('queued','processing','ready','failed','blocked')),
  ingest_error text,
  ingested_at timestamptz,
  cdn_key text,
  cdn_url text,
  publish_status text not null default 'not_requested' check (publish_status in ('not_requested','queued','published','failed')),
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_native_media_storage_path_unique
  on public.media_assets(storage_path) where storage_path is not null;
create index if not exists idx_native_media_review_state_created on public.media_assets(review_state, created_at desc);
create index if not exists idx_native_media_ingest_status_created on public.media_assets(ingest_status, created_at asc);
create index if not exists idx_native_media_phash on public.media_assets(phash);
create index if not exists idx_native_media_embedding on public.media_assets using hnsw (image_embedding vector_cosine_ops) with (m=16, ef_construction=64);

create table if not exists public.review_queue (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected','skipped')),
  is_duplicate boolean not null default false,
  duplicate_similarity real not null default 0,
  duplicate_asset_ids jsonb not null default '[]'::jsonb,
  user_corrections jsonb not null default '{}'::jsonb,
  sku_match jsonb not null default '{}'::jsonb,
  metadata_draft jsonb not null default '{}'::jsonb,
  dedup_summary jsonb not null default '{}'::jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_native_review_status_created on public.review_queue(status, created_at asc);
create index if not exists idx_native_review_asset on public.review_queue(media_asset_id, created_at asc);
with duplicate_rows as (
  select id, row_number() over (partition by media_asset_id order by created_at asc, id asc) as row_number
  from public.review_queue
)
delete from public.review_queue q using duplicate_rows d
where q.id = d.id and d.row_number > 1;
create unique index if not exists idx_native_review_asset_unique on public.review_queue(media_asset_id);

create table if not exists public.media_usages (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  channel text not null,
  used_by text not null,
  note text,
  used_at timestamptz not null default now()
);

create table if not exists public.media_ingest_jobs (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  job_kind text not null check (job_kind in ('analyze_image','publish_wordpress')),
  status text not null default 'queued' check (status in ('queued','processing','succeeded','failed','blocked','cancelled')),
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_native_ingest_claim on public.media_ingest_jobs(status, run_after, created_at) where status in ('queued','processing');

create table if not exists public.sku_reference_embeddings (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  embedding vector(512) not null,
  source_media_asset_id uuid references public.media_assets(id) on delete set null,
  source_url text,
  source_kind text not null default 'review_correction',
  is_primary boolean not null default false,
  is_active boolean not null default true,
  embedding_provider text,
  embedding_model text,
  embedding_version text,
  embedding_dimension integer,
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_native_sku_reference_source on public.sku_reference_embeddings(sku, source_media_asset_id) where source_media_asset_id is not null;
create unique index if not exists idx_native_sku_reference_url on public.sku_reference_embeddings(sku, source_url) where source_url is not null;
create index if not exists idx_native_sku_reference_embedding on public.sku_reference_embeddings using hnsw (embedding vector_cosine_ops) with (m=16, ef_construction=64);

create table if not exists public.metadata_few_shot_examples (
  id uuid primary key default gen_random_uuid(),
  source_media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  correction_log_id uuid,
  input_context jsonb not null default '{}'::jsonb,
  accepted_metadata jsonb not null,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.review_correction_log (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  review_queue_id uuid not null references public.review_queue(id) on delete cascade,
  correction_kind text not null check (correction_kind in ('sku','metadata')),
  fields jsonb not null,
  before_value jsonb not null default '{}'::jsonb,
  after_value jsonb not null default '{}'::jsonb,
  reviewed_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.media_dedup_matches (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  candidate_media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  method text not null,
  similarity real,
  hamming_distance integer,
  threshold jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(media_asset_id, candidate_media_asset_id, method)
);

create table if not exists public.media_tagging_runs (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  job_id uuid references public.media_ingest_jobs(id) on delete set null,
  tagger text not null,
  status text not null,
  model text,
  prompt_version text,
  output jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.wordpress_media_exports (
  media_asset_id uuid primary key references public.media_assets(id) on delete cascade,
  cdn_url text not null,
  alt_text text not null default '',
  caption text not null default '',
  width integer,
  height integer,
  mime_type text,
  updated_at timestamptz not null default now()
);

create table if not exists public.missing_shots (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  brand text,
  reason text not null,
  query_origin text,
  status text not null default 'open' check (status in ('open','assigned','completed')),
  created_at timestamptz not null default now()
);

create table if not exists public.vision_rate_limits (
  key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null default 0
);

create table if not exists public.verity_ai_vision_config (
  config_key text primary key default 'default' check (config_key = 'default'),
  provider text not null default 'openai-compatible',
  base_url text not null,
  model text not null,
  image_detail text not null default 'high' check (image_detail in ('auto','low','high')),
  max_tokens integer not null default 1000 check (max_tokens between 256 and 4096),
  system_prompt text not null,
  api_key_ciphertext text not null,
  api_key_nonce text not null,
  api_key_auth_tag text not null,
  encryption_version smallint not null default 1,
  active boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.verity_ai_embedding_config (
  config_key text primary key default 'default' check (config_key = 'default'),
  provider text not null default '9router',
  base_url text not null,
  model text not null,
  embedding_version text not null,
  embedding_dimension smallint not null default 512,
  api_key_ciphertext text not null,
  api_key_nonce text not null,
  api_key_auth_tag text not null,
  encryption_version smallint not null default 1,
  active boolean not null default true,
  fallback_provider text,
  fallback_base_url text,
  fallback_model text,
  fallback_api_key_ciphertext text,
  fallback_api_key_nonce text,
  fallback_api_key_auth_tag text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.verity_metadata_defaults_config (
  config_key text primary key default 'default' check (config_key = 'default'),
  author text not null default 'VerityDAM Platform',
  copyright text not null default '© 2026 VerityDAM Platform. All rights reserved.',
  credit text not null default 'VerityDAM Team',
  description text not null default '',
  keywords text[] not null default '{}',
  auto_apply boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.verity_metadata_defaults_config(config_key) values ('default') on conflict do nothing;

create table if not exists public.verity_taxonomy_options (
  id uuid primary key default gen_random_uuid(),
  facet text not null,
  value text not null,
  label text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique(facet, value)
);
create index if not exists idx_native_taxonomy_facet_order on public.verity_taxonomy_options(facet, is_active, sort_order, label);

insert into public.verity_taxonomy_options(facet, value, label, sort_order) values
  ('category','Công trình','Công trình',10),
  ('category','Showroom','Showroom',20),
  ('category','Studio','Studio',30),
  ('category','Banner','Banner',40),
  ('space','Phòng khách','Phòng khách',10),
  ('space','Bếp','Bếp',20),
  ('space','Cửa chính','Cửa chính',30),
  ('space','Phòng ngủ','Phòng ngủ',40),
  ('space','Toàn cảnh','Toàn cảnh',50),
  ('brand','Acme','Acme',10),
  ('brand','Lumos','Lumos',20),
  ('brand','Apple HomeKit','Apple HomeKit',30),
  ('status','Mới','Mới',10),
  ('status','Đang lắp','Đang lắp',20),
  ('status','Đã bàn giao','Đã bàn giao',30),
  ('permission','public','Public',10),
  ('permission','internal','Chỉ nội bộ',20),
  ('safety','only_ai','Ảnh AI',10),
  ('safety','only_people','Có người',20),
  ('safety','only_internal','Chỉ nội bộ',30)
on conflict(facet,value) do nothing;

create table if not exists public.verity_synonyms_config (
  config_key text primary key default 'default',
  items jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.verity_synonyms_config(config_key) values ('default') on conflict do nothing;

-- Older databases may have been created from the initial schema. Keep this
-- migration additive so a native cutover can be applied without data loss.
alter table public.media_assets add column if not exists created_by uuid;
alter table public.media_assets add column if not exists storage_path text;
alter table public.media_assets add column if not exists thumbnail_path text;
alter table public.media_assets add column if not exists review_state text not null default 'pending';
alter table public.media_assets add column if not exists ingest_status text not null default 'queued';

create table if not exists public.verity_products (
  id uuid primary key default gen_random_uuid(), code text not null unique,
  display_name text not null, brand text not null default 'unknown', category text,
  model_name text, primary_sku text, aliases text[] not null default '{}',
  lifecycle text not null default 'active' check (lifecycle in ('draft','active','discontinued')),
  is_searchable boolean not null default true, source_system text not null,
  external_id text not null, source_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(source_system, external_id)
);
create table if not exists public.media_asset_products (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  product_id uuid not null references public.verity_products(id) on delete restrict,
  role text not null default 'primary' check (role in ('primary','secondary','background','packaging')),
  confidence real check (confidence between 0 and 1), source text not null,
  evidence jsonb not null default '{}'::jsonb,
  review_state text not null default 'draft' check (review_state in ('draft','confirmed','rejected')),
  model_id text, model_version text, created_by uuid, created_at timestamptz not null default now(),
  unique(media_asset_id, product_id)
);
create unique index if not exists uq_native_media_asset_primary_product on public.media_asset_products(media_asset_id) where role='primary' and review_state <> 'rejected';
alter table public.sku_reference_embeddings add column if not exists product_id uuid references public.verity_products(id) on delete set null;

-- Production vector-space guardrails. Local CLIP/legacy vectors may exist in a
-- separate personal database, but they must never be inserted into the native
-- company tables. Keep the checks additive and idempotent for repeat deploys.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'media_assets_production_embedding_space_ck'
  ) then
    alter table public.media_assets add constraint media_assets_production_embedding_space_ck
      check (
        image_embedding is null or (
          embedding_provider = '9router'
          and embedding_model = 'jina-ai/jina-clip-v2'
          and embedding_version = 'jina-clip-v2-v1'
          and embedding_dimension = 512
          and vector_dims(image_embedding) = 512
        )
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sku_reference_production_embedding_space_ck'
  ) then
    alter table public.sku_reference_embeddings add constraint sku_reference_production_embedding_space_ck
      check (
        embedding_provider = '9router'
        and embedding_model = 'jina-ai/jina-clip-v2'
        and embedding_version = 'jina-clip-v2-v1'
        and embedding_dimension = 512
        and vector_dims(embedding) = 512
      );
  end if;
end
$$;
