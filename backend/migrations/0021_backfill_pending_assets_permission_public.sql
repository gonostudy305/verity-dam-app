-- Backfill any pending review queue assets to public permission by default
update public.media_assets
set permission = 'public',
    ai_flags = jsonb_set(coalesce(ai_flags, '{}'::jsonb), '{is_internal}', 'false'::jsonb),
    updated_at = now()
where review_state = 'pending'
  and deleted_at is null
  and permission = 'internal';
