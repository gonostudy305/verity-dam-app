-- DDL Migration for OpenCLIP Shadow Production Trial
-- Space ID: verity-openclip-b32-datacomp-256-v1
-- Zero interference with production media_assets / sku_reference_embeddings

create table if not exists public.sku_reference_embeddings_shadow (
    id bigserial primary key,
    space_id text not null,
    sku text not null,
    source_url text not null,
    asset_sha256 text,
    embedding vector(512) not null,
    model_sha256 text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    constraint uq_shadow_ref_space_sku_url unique (space_id, sku, source_url)
);

create index if not exists idx_shadow_ref_space_sku 
    on public.sku_reference_embeddings_shadow (space_id, sku);

create table if not exists public.media_asset_shadow_predictions (
    id bigserial primary key,
    media_asset_id uuid not null references public.media_assets(id) on delete cascade,
    space_id text not null,
    model_sha256 text not null,
    openclip_top1_sku text,
    openclip_top1_similarity double precision,
    openclip_top2_sku text,
    openclip_top2_similarity double precision,
    openclip_margin double precision,
    jina_production_sku text,
    jina_confidence double precision,
    agreement boolean,
    latency_ms double precision,
    status text not null default 'SUCCESS',
    error_message text,
    created_at timestamptz not null default now(),
    constraint uq_shadow_pred_asset_space unique (media_asset_id, space_id)
);

create index if not exists idx_shadow_pred_space_created 
    on public.media_asset_shadow_predictions (space_id, created_at desc);
