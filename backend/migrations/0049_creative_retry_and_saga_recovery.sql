-- A failed generation can have one, and only one, explicit manual successor.
-- This is a database invariant rather than a UI/API convention so concurrent
-- operators cannot create two billable retry attempts.

ALTER TABLE public.ai_image_generations
  ADD COLUMN IF NOT EXISTS retry_of_generation_id UUID NULL
    REFERENCES public.ai_image_generations(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_image_generation_retry_parent
  ON public.ai_image_generations(retry_of_generation_id)
  WHERE retry_of_generation_id IS NOT NULL;
