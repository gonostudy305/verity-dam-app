import { INITIAL_MEDIA_ASSETS, INITIAL_REVIEW_QUEUE } from '../mock-data';
import type { MediaListParams } from '../media-api';
import type { MediaAsset, ReviewQueueItem, CropConfig } from '../../types/media';
import { stripSearchStopwords } from './native-synonyms';

const demoLibraryAssets = structuredClone(INITIAL_MEDIA_ASSETS);
const demoReviewQueue = structuredClone(INITIAL_REVIEW_QUEUE);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesSelected(values: string[], value: string | undefined): boolean {
  return values.length === 0 || values.includes(value || '');
}

function matchesQuery(asset: MediaAsset, query: string): boolean {
  if (!query) return true;
  // Keep local dev-mode search behavior in parity with the native/production
  // path: "ảnh robot" must match the same rows as "robot" (see
  // stripSearchStopwords in native-synonyms.ts for the root-cause note).
  const strippedQuery = stripSearchStopwords(query);
  if (!strippedQuery) return true;
  const haystack = [asset.title, asset.sku, asset.brand, asset.category, asset.space || '']
    .join(' ')
    .toLocaleLowerCase('vi-VN');
  return haystack.includes(strippedQuery.toLocaleLowerCase('vi-VN'));
}

function matchesFilters(asset: MediaAsset, params: MediaListParams): boolean {
  return matchesQuery(asset, params.query)
    && matchesSelected(params.category, asset.category)
    && matchesSelected(params.space, asset.space)
    && matchesSelected(params.status, asset.status)
    && matchesSelected(params.permission, asset.permission)
    // The production query currently maps the source parameter to brand.
    && matchesSelected(params.source, asset.brand)
    && matchesSelected(params.mediaType, asset.media_type)
    && (!params.onlyAi || asset.ai_flags.is_ai)
    && (!params.onlyPeople || asset.ai_flags.has_people)
    && (!params.onlyInternal || asset.permission === 'internal');
}

function sortAssets(assets: MediaAsset[], sort: MediaListParams['sort']): MediaAsset[] {
  return [...assets].sort((left, right) => {
    if (sort === 'most_used') return right.usage_count - left.usage_count;
    if (sort === 'unused') return left.usage_count - right.usage_count;
    return Date.parse(right.created_at) - Date.parse(left.created_at);
  });
}

export function listDemoLibraryMedia(params: MediaListParams) {
  const matchingAssets = sortAssets(
    demoLibraryAssets.filter((asset) => matchesFilters(asset, params)),
    params.sort
  );
  const start = (params.page - 1) * params.pageSize;

  return {
    data: clone(matchingAssets.slice(start, start + params.pageSize)),
    total: matchingAssets.length,
  };
}

export function getDemoMediaAsset(id: string): MediaAsset | undefined {
  const asset = demoLibraryAssets.find((candidate) => candidate.id === id);
  return asset ? clone(asset) : undefined;
}

export function listDemoReviewItems(): ReviewQueueItem[] {
  return clone(demoReviewQueue.filter((item) => item.status === 'pending'));
}

export function resolveDemoReviewItem(
  id: string,
  decision: 'approved' | 'rejected',
  patch: Record<string, string | string[]>
) {
  const item = demoReviewQueue.find((candidate) => candidate.id === id && candidate.status === 'pending');
  if (!item) return undefined;

  for (const [key, value] of Object.entries(patch)) {
    (item.asset as unknown as Record<string, unknown>)[key] = value;
    item.user_corrections[key as keyof MediaAsset] = true;
  }

  item.status = decision;
  if (decision === 'approved' && !demoLibraryAssets.some((asset) => asset.id === item.asset.id)) {
    demoLibraryAssets.unshift(clone(item.asset));
  }

  return { id: item.id, status: item.status };
}

export function updateDemoAssetCropConfig(
  id: string,
  presetId: string,
  cropConfig: CropConfig
): MediaAsset | undefined {
  const asset = demoLibraryAssets.find((candidate) => candidate.id === id);
  if (!asset) return undefined;
  if (!asset.crop_configs) {
    asset.crop_configs = {};
  }
  asset.crop_configs[presetId] = {
    ...cropConfig,
    updated_at: new Date().toISOString(),
    updated_by: 'team',
  };
  return clone(asset);
}
