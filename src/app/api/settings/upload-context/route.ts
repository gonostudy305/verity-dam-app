import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeAdmin, requireNativeMember } from '@/lib/server/native-auth';
import {
  MAX_ICON_KEY_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_PRESET_VALUE_LENGTH,
  MAX_QUICK_PRESETS,
  MAX_TAG_GROUPS,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_GROUP,
  type UploadQuickPreset,
  type UploadTagGroup,
} from '@/config/upload-context';
import {
  bustUploadContextConfigCache,
  getUploadContextConfig,
  saveUploadContextConfig,
} from '@/lib/server/upload-context-config';

export const dynamic = 'force-dynamic';

// ── GET /api/settings/upload-context ──────────────────────────────────────────
// Any authenticated member can read the quick-select presets -- the upload
// page is used by regular content uploaders, not just admins.
export async function GET() {
  try {
    await requireNativeMember();
    const config = await getUploadContextConfig();
    return NextResponse.json({ data: config });
  } catch (error) {
    return errorResponse(error);
  }
}

// ── PUT /api/settings/upload-context ──────────────────────────────────────────
// Only admins may edit the shared quick-select presets / tag groups.
export async function PUT(request: NextRequest) {
  try {
    const { user } = await requireNativeAdmin();

    const body = await request.json().catch(() => {
      throw new Error('Request body must be valid JSON.');
    });

    if (!Array.isArray(body?.quickPresets) || !Array.isArray(body?.tagGroups)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Body must have "quickPresets" and "tagGroups" arrays.');
    }

    if (body.quickPresets.length > MAX_QUICK_PRESETS) {
      throw new ApiError(400, 'INVALID_INPUT', `At most ${MAX_QUICK_PRESETS} quick presets are allowed.`);
    }
    if (body.tagGroups.length > MAX_TAG_GROUPS) {
      throw new ApiError(400, 'INVALID_INPUT', `At most ${MAX_TAG_GROUPS} tag groups are allowed.`);
    }

    const quickPresets: UploadQuickPreset[] = (body.quickPresets as unknown[]).map((item, i) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as Record<string, unknown>).label !== 'string' ||
        typeof (item as Record<string, unknown>).icon !== 'string' ||
        typeof (item as Record<string, unknown>).value !== 'string'
      ) {
        throw new ApiError(400, 'INVALID_INPUT', `Quick preset at index ${i} must have string fields: label, icon, value.`);
      }
      const value = item as Record<string, string>;
      const label = value.label.trim();
      const icon = value.icon.trim();
      const presetValue = value.value.trim();
      if (!label || !presetValue || label.length > MAX_LABEL_LENGTH || icon.length > MAX_ICON_KEY_LENGTH || presetValue.length > MAX_PRESET_VALUE_LENGTH) {
        throw new ApiError(400, 'INVALID_INPUT', `Quick preset at index ${i} contains an empty or oversized value.`);
      }
      return { label, icon, value: presetValue };
    });

    const tagGroups: UploadTagGroup[] = (body.tagGroups as unknown[]).map((group, i) => {
      if (
        typeof group !== 'object' ||
        group === null ||
        typeof (group as Record<string, unknown>).name !== 'string' ||
        typeof (group as Record<string, unknown>).icon !== 'string' ||
        !Array.isArray((group as Record<string, unknown>).tags)
      ) {
        throw new ApiError(400, 'INVALID_INPUT', `Tag group at index ${i} must have name, icon (strings) and a tags array.`);
      }
      const value = group as Record<string, unknown>;
      const name = (value.name as string).trim();
      const icon = (value.icon as string).trim();
      const rawTags = value.tags as unknown[];
      if (!name || name.length > MAX_LABEL_LENGTH || icon.length > MAX_ICON_KEY_LENGTH) {
        throw new ApiError(400, 'INVALID_INPUT', `Tag group at index ${i} has an empty or oversized name/icon.`);
      }
      if (rawTags.length > MAX_TAGS_PER_GROUP) {
        throw new ApiError(400, 'INVALID_INPUT', `Tag group "${name}" may contain at most ${MAX_TAGS_PER_GROUP} tags.`);
      }
      const tags = rawTags.map((tag, j) => {
        if (typeof tag !== 'string') {
          throw new ApiError(400, 'INVALID_INPUT', `Tag group "${name}", tag ${j} must be a string.`);
        }
        const trimmed = tag.trim();
        if (!trimmed || trimmed.length > MAX_TAG_LENGTH) {
          throw new ApiError(400, 'INVALID_INPUT', `Tag group "${name}", tag ${j} is empty or oversized.`);
        }
        return trimmed;
      });
      return { name, icon, tags };
    });

    const saved = await saveUploadContextConfig(quickPresets, tagGroups, user.email ?? user.id);

    // Bust cache so the upload page picks up new data immediately.
    bustUploadContextConfigCache();

    return NextResponse.json({ data: saved });
  } catch (error) {
    return errorResponse(error);
  }
}
