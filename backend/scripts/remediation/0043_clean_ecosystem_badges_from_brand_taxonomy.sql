-- Remediation 0043: Move ecosystem and connectivity badges from facet 'brand' to facet 'ecosystem'
--
-- Context:
-- In public.verity_taxonomy_options, items such as 'Apple HomeKit', 'Matter', etc. were stored under facet = 'brand'.
-- This caused vision taxonomy hinting and metadata normalizer to present them as valid manufacturer brands,
-- causing AI Vision to mistakenly classify hardware products (like Acme or Lyra smart locks) as 'Apple HomeKit'.
--
-- This remediation moves these items to facet = 'ecosystem' so that they no longer appear as manufacturer brands.

BEGIN;

-- 1. Identify and update ecosystem entries
UPDATE public.verity_taxonomy_options
SET facet = 'ecosystem',
    updated_at = now()
WHERE facet = 'brand'
  AND lower(value) = ANY(ARRAY[
    'apple homekit', 'matter', 'google home', 'google assistant',
    'amazon alexa', 'zigbee', 'zigbee 3.0', 'thread', 'bluetooth',
    'wifi', 'tera smart', 'smart life', 'z-wave'
  ]);

-- 2. Audit check: verify the migration
DO $$
DECLARE
    ecosystem_count INTEGER;
    residual_brand_count INTEGER;
BEGIN
    SELECT count(*) INTO ecosystem_count
    FROM public.verity_taxonomy_options
    WHERE facet = 'ecosystem';

    SELECT count(*) INTO residual_brand_count
    FROM public.verity_taxonomy_options
    WHERE facet = 'brand'
      AND lower(value) = ANY(ARRAY[
        'apple homekit', 'matter', 'google home', 'google assistant',
        'amazon alexa', 'zigbee', 'zigbee 3.0', 'thread', 'bluetooth',
        'wifi', 'tera smart', 'smart life', 'z-wave'
      ]);

    IF residual_brand_count > 0 THEN
        RAISE EXCEPTION 'Verification failed: % ecosystem items still remain under facet brand!', residual_brand_count;
    END IF;

    RAISE NOTICE 'Verification passed: % items are now under facet ecosystem (0 residual under facet brand).', ecosystem_count;
END $$;

COMMIT;
