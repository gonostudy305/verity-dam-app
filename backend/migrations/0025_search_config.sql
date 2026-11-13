-- Search Intelligence and ranking configuration.
--
-- Migration 0024 is already reserved for upload-context presets and tag
-- groups. Keep this configuration in its own additive migration so the
-- native migration ledger never has two meanings for the same id.
--
-- NO RLS: native production protects writes at the API layer through
-- requireNativeAdmin().

CREATE TABLE IF NOT EXISTS public.verity_search_config (
  id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rrf_k               integer NOT NULL DEFAULT 60,
  semantic_weight     double precision NOT NULL DEFAULT 1.0,
  lexical_weight      double precision NOT NULL DEFAULT 1.0,
  mmr_lambda          double precision NOT NULL DEFAULT 0.7,
  mmr_pool_size       integer NOT NULL DEFAULT 40,
  mmr_output_size     integer NOT NULL DEFAULT 20,
  rerank_lexical      double precision NOT NULL DEFAULT 1.0,
  rerank_fuzzy        double precision NOT NULL DEFAULT 0.5,
  rerank_rrf          double precision NOT NULL DEFAULT 10.0,
  rerank_entity       double precision NOT NULL DEFAULT 1.0,
  semantic_enabled    boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid
);

INSERT INTO public.verity_search_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
