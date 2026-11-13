'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { apiRequest } from '@/lib/client/api';
import { DEFAULT_TAXONOMY, type TaxonomyConfig } from '@/config/taxonomy';

interface TaxonomyContextValue {
  taxonomy: TaxonomyConfig;
  loading: boolean;
  reload: () => void;
}

const TaxonomyContext = createContext<TaxonomyContextValue>({
  taxonomy: DEFAULT_TAXONOMY,
  loading: true,
  reload: () => undefined,
});

// AppShell (and this provider) remount on every page navigation; reuse the
// last loaded taxonomy so filters do not flash the bootstrap defaults.
let cachedTaxonomy: TaxonomyConfig | null = null;

export function TaxonomyProvider({ children }: { children: React.ReactNode }) {
  const [taxonomy, setTaxonomy] = useState<TaxonomyConfig>(cachedTaxonomy ?? DEFAULT_TAXONOMY);
  const [loading, setLoading] = useState(cachedTaxonomy === null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: TaxonomyConfig }>('/api/taxonomy')
      .then(({ data }) => {
        if (!data) return;
        cachedTaxonomy = data;
        if (!cancelled) setTaxonomy(data);
      })
      .catch(() => {
        // Bootstrap defaults keep the shell usable while an operator applies
        // the migration or while a transient config request is unavailable.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const value = useMemo(
    () => ({ taxonomy, loading, reload: () => setReloadKey((key) => key + 1) }),
    [loading, taxonomy]
  );
  return <TaxonomyContext.Provider value={value}>{children}</TaxonomyContext.Provider>;
}

export function useTaxonomy(): TaxonomyContextValue {
  return useContext(TaxonomyContext);
}
