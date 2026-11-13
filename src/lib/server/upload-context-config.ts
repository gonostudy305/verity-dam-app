import { requireNativeDatabase } from './native-db';
import {
  DEFAULT_UPLOAD_CONTEXT,
  type UploadContextConfig,
  type UploadQuickPreset,
  type UploadTagGroup,
} from '@/config/upload-context';

let cache: { at: number; config: UploadContextConfig } | null = null;
const TTL = 60_000;

export async function getUploadContextConfig(): Promise<UploadContextConfig> {
  if (cache && Date.now() - cache.at < TTL) return cache.config;

  // Degrade to bootstrap defaults on any failure (DB unconfigured, migration
  // not applied yet, transient connection error) rather than throwing --
  // the upload page must keep rendering its quick-select chips regardless.
  try {
    const result = await requireNativeDatabase().query<{
      quick_presets: unknown;
      tag_groups: unknown;
      updated_at: Date | string | null;
    }>(
      `select quick_presets, tag_groups, updated_at
       from public.verity_upload_context_config where config_key = 'default' limit 1`
    );
    const row = result.rows[0];
    const config: UploadContextConfig = row
      ? {
          quickPresets: Array.isArray(row.quick_presets)
            ? (row.quick_presets as UploadQuickPreset[])
            : DEFAULT_UPLOAD_CONTEXT.quickPresets,
          tagGroups: Array.isArray(row.tag_groups)
            ? (row.tag_groups as UploadTagGroup[])
            : DEFAULT_UPLOAD_CONTEXT.tagGroups,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        }
      : DEFAULT_UPLOAD_CONTEXT;
    cache = { at: Date.now(), config };
    return config;
  } catch {
    return DEFAULT_UPLOAD_CONTEXT;
  }
}

export async function saveUploadContextConfig(
  quickPresets: UploadQuickPreset[],
  tagGroups: UploadTagGroup[],
  updatedBy: string
): Promise<UploadContextConfig> {
  const result = await requireNativeDatabase().query<{ updated_at: Date | string }>(
    `insert into public.verity_upload_context_config (config_key, quick_presets, tag_groups, updated_by, updated_at)
     values ('default', $1::jsonb, $2::jsonb, $3, now())
     on conflict (config_key) do update set
       quick_presets = excluded.quick_presets,
       tag_groups = excluded.tag_groups,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning updated_at`,
    [JSON.stringify(quickPresets), JSON.stringify(tagGroups), updatedBy]
  );
  const config: UploadContextConfig = {
    quickPresets,
    tagGroups,
    updatedAt: new Date(result.rows[0].updated_at).toISOString(),
  };
  cache = { at: Date.now(), config };
  return config;
}

export function bustUploadContextConfigCache() {
  cache = null;
}
