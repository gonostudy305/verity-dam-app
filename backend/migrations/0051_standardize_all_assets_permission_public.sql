-- 0051_standardize_all_assets_permission_public.sql
-- Standardize all media assets to public permission
-- Rationale: Assets ingested/pushed to VerityDAM DAM are intended for broad marketing,
-- website, and social use. Unpushed/private files remain on local disks.

ALTER TABLE public.media_assets ALTER COLUMN permission SET DEFAULT 'public';

UPDATE public.media_assets
SET permission = 'public',
    ai_flags = jsonb_set(coalesce(ai_flags, '{}'::jsonb), '{is_internal}', 'false'::jsonb),
    updated_at = now()
WHERE permission = 'internal';
