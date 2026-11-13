'use client';

import { useEffect, useState } from 'react';

import { apiRequest } from '@/lib/client/api';
import { DEFAULT_UPLOAD_CONTEXT, type UploadContextConfig } from '@/config/upload-context';

/**
 * Loads the Settings-configurable upload quick-select presets (Mẫu nhanh +
 * tag groups). A single consumer today (BatchContextSelector.tsx), so this
 * is a plain fetch-on-mount hook rather than a Context provider like
 * useTaxonomy.tsx -- add a provider only if a second consumer shows up.
 *
 * Falls back to DEFAULT_UPLOAD_CONTEXT immediately and on any fetch error,
 * so the upload page renders the same chips it always has while the config
 * endpoint is unreachable or the migration hasn't run yet.
 */
export function useUploadContextConfig(): { config: UploadContextConfig; loading: boolean } {
  const [config, setConfig] = useState<UploadContextConfig>(DEFAULT_UPLOAD_CONTEXT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: UploadContextConfig }>('/api/settings/upload-context')
      .then(({ data }) => {
        if (!cancelled && data) setConfig(data);
      })
      .catch(() => {
        // Bootstrap defaults keep the upload page usable while an operator
        // applies the migration or while the endpoint is transiently down.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { config, loading };
}
