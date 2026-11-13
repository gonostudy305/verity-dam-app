-- 0041_fix_canonical_publication_trigger.sql
-- Fix canonical publication trigger to fire after ANY update where
-- canonical_version has been bumped by the BEFORE UPDATE trigger.
-- In PostgreSQL, 'UPDATE OF col' on an AFTER trigger does not fire
-- if the column was only mutated by a BEFORE trigger, causing canonical drift.

DROP TRIGGER IF EXISTS trg_enqueue_canonical_media_publication ON public.media_assets;

CREATE TRIGGER trg_enqueue_canonical_media_publication
AFTER INSERT OR UPDATE ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.enqueue_canonical_media_publication();
