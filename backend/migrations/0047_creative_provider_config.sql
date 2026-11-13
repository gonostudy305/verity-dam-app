-- 0047_creative_provider_config.sql
-- Provider credentials for the creative worker are managed from Settings and
-- encrypted at rest. The worker receives only the shared master key and
-- decrypts the selected provider at job time.

CREATE TABLE IF NOT EXISTS public.verity_ai_creative_config (
  config_key TEXT PRIMARY KEY DEFAULT 'default' CHECK (config_key = 'default'),
  openai_base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  openai_model TEXT NOT NULL DEFAULT 'gpt-image-2.5-flare-2026-09-08',
  openai_api_key_ciphertext TEXT NULL,
  openai_api_key_nonce TEXT NULL,
  openai_api_key_auth_tag TEXT NULL,
  gemini_base_url TEXT NOT NULL DEFAULT 'https://generativelanguage.googleapis.com/v1beta',
  gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-flash-image',
  gemini_api_key_ciphertext TEXT NULL,
  gemini_api_key_nonce TEXT NULL,
  gemini_api_key_auth_tag TEXT NULL,
  encryption_version SMALLINT NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((openai_api_key_ciphertext IS NULL AND openai_api_key_nonce IS NULL AND openai_api_key_auth_tag IS NULL)
      OR (openai_api_key_ciphertext IS NOT NULL AND openai_api_key_nonce IS NOT NULL AND openai_api_key_auth_tag IS NOT NULL)),
  CHECK ((gemini_api_key_ciphertext IS NULL AND gemini_api_key_nonce IS NULL AND gemini_api_key_auth_tag IS NULL)
      OR (gemini_api_key_ciphertext IS NOT NULL AND gemini_api_key_nonce IS NOT NULL AND gemini_api_key_auth_tag IS NOT NULL)),
  CHECK (openai_api_key_ciphertext IS NOT NULL OR gemini_api_key_ciphertext IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_verity_ai_creative_config_active
  ON public.verity_ai_creative_config(active);
