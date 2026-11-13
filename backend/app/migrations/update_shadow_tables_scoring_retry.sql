-- Add is_primary to sku_reference_embeddings_shadow for exact production scoring parity
alter table public.sku_reference_embeddings_shadow 
    add column if not exists is_primary boolean not null default false;

create index if not exists idx_shadow_ref_space_sku_primary 
    on public.sku_reference_embeddings_shadow (space_id, sku) 
    where is_primary = true;

-- Add bounded retry columns to media_asset_shadow_predictions
alter table public.media_asset_shadow_predictions
    add column if not exists attempt_count integer not null default 1,
    add column if not exists max_attempts integer not null default 5,
    add column if not exists next_retry_at timestamp with time zone not null default now();

create index if not exists idx_shadow_pred_retry 
    on public.media_asset_shadow_predictions (status, next_retry_at) 
    where status = 'FAILED';
