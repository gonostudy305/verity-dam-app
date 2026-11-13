import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';

import { attachMediaAssetProduct } from './native-media';
import { ApiError } from './http';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

function createMockClient(
  queryHandler: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>
): PoolClient {
  return {
    query: (text: any, params?: any) => queryHandler(text, params),
  } as unknown as PoolClient;
}

test('attachMediaAssetProduct: rejects invalid UUID mediaAssetId', async () => {
  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: 'not-a-uuid', sku: 'AQA-01' }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INVALID_ID');
      return true;
    }
  );
});

test('attachMediaAssetProduct: rejects empty or whitespace sku', async () => {
  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: VALID_UUID, sku: '   ' }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INVALID_SKU');
      return true;
    }
  );
});

test('attachMediaAssetProduct: rejects role=primary with PRIMARY_ROLE_NOT_ALLOWED', async () => {
  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: VALID_UUID, sku: 'AQA-01', role: 'primary' }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'PRIMARY_ROLE_NOT_ALLOWED');
      assert.ok(err.message.includes('trường SKU'));
      return true;
    }
  );
});

test('attachMediaAssetProduct: rejects invalid role not in taggable roles', async () => {
  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: VALID_UUID, sku: 'AQA-01', role: 'unknown_role' }),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INVALID_ROLE');
      return true;
    }
  );
});

test('attachMediaAssetProduct: throws 404 NOT_FOUND on soft-deleted or rejected asset', async () => {
  const client = createMockClient(async (text) => {
    if (text.includes('from public.media_assets')) {
      return { rows: [] }; // asset not found or deleted/rejected
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: VALID_UUID, sku: 'AQA-01' }, client),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    }
  );
});

test('attachMediaAssetProduct: throws 404 PRODUCT_NOT_FOUND when SKU does not resolve', async () => {
  const client = createMockClient(async (text) => {
    if (text.includes('from public.media_assets')) {
      return { rows: [{ id: VALID_UUID }] };
    }
    if (text.includes('from public.verity_products')) {
      return { rows: [] }; // SKU does not resolve to an active product
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: VALID_UUID, sku: 'NON_EXISTENT_SKU' }, client),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 'PRODUCT_NOT_FOUND');
      assert.ok(err.message.includes('SKU chưa có trong danh mục'));
      return true;
    }
  );
});

test('attachMediaAssetProduct: duplicate attach throws 409 PRODUCT_ALREADY_LINKED carrying existing link', async () => {
  const client = createMockClient(async (text) => {
    if (text.includes('from public.media_assets')) {
      return { rows: [{ id: VALID_UUID }] };
    }
    if (text.includes('from public.verity_products') && text.includes('where lifecycle <>')) {
      return { rows: [{ id: 'prod-123', code: 'AQA-01', display_name: 'Acme Hub' }] };
    }
    if (text.includes('insert into public.media_asset_products')) {
      return { rows: [] }; // ON CONFLICT DO NOTHING -> 0 rows returned
    }
    if (text.includes('from public.media_asset_products mp')) {
      return {
        rows: [
          {
            id: 'link-456',
            product_id: 'prod-123',
            role: 'secondary',
            confidence: null,
            source: 'human',
            review_state: 'confirmed',
            created_at: '2026-09-09T10:00:00Z',
            code: 'AQA-01',
            display_name: 'Acme Hub',
            brand: 'Acme',
            model_name: 'M2',
            category: 'hub',
          },
        ],
      };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => attachMediaAssetProduct({ mediaAssetId: VALID_UUID, sku: 'AQA-01' }, client),
    (err: any) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'PRODUCT_ALREADY_LINKED');
      const details = err.details as { link?: any } | undefined;
      assert.ok(details?.link);
      assert.equal(details.link.id, 'link-456');
      assert.equal(details.link.code, 'AQA-01');
      return true;
    }
  );
});

test('attachMediaAssetProduct: successful attach defaults role=secondary and confirmed/human', async () => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const client = createMockClient(async (text, params) => {
    calls.push({ text, params });
    if (text.includes('from public.media_assets')) {
      return { rows: [{ id: VALID_UUID }] };
    }
    if (text.includes('from public.verity_products') && text.includes('where lifecycle <>')) {
      return {
        rows: [
          {
            id: 'prod-123',
            code: 'AQA-01',
            display_name: 'Acme Hub M2',
            brand: 'Acme',
            model_name: 'M2',
            category: 'hub',
          },
        ],
      };
    }
    if (text.includes('insert into public.media_asset_products')) {
      return {
        rows: [
          {
            id: 'new-link-789',
            product_id: 'prod-123',
            role: params?.[2] || 'secondary',
            confidence: null,
            source: 'human',
            review_state: 'confirmed',
            created_at: '2026-09-09T12:00:00Z',
            code: 'AQA-01',
            display_name: 'Acme Hub M2',
            brand: 'Acme',
            model_name: 'M2',
            category: 'hub',
          },
        ],
      };
    }
    return { rows: [] };
  });

  const result = await attachMediaAssetProduct(
    { mediaAssetId: VALID_UUID, sku: 'AQA-01', createdBy: 'reviewer-user-id' },
    client
  );

  assert.equal(result.id, 'new-link-789');
  assert.equal(result.product_id, 'prod-123');
  assert.equal(result.role, 'secondary');
  assert.equal(result.review_state, 'confirmed');
  assert.equal(result.source, 'human');
  assert.equal(result.code, 'AQA-01');
  assert.equal(result.brand, 'Acme');

  // Verify parameters passed to insert
  const insertCall = calls.find((c) => c.text.includes('insert into public.media_asset_products'));
  assert.ok(insertCall);
  assert.deepEqual(insertCall.params, [VALID_UUID, 'prod-123', 'secondary', 'reviewer-user-id']);
});

test('attachMediaAssetProduct: allows background and packaging roles', async () => {
  for (const allowedRole of ['background', 'packaging'] as const) {
    const client = createMockClient(async (text, params) => {
      if (text.includes('insert into public.media_asset_products')) {
        return {
          rows: [
            {
              id: `link-${allowedRole}`,
              product_id: 'prod-999',
              role: allowedRole,
              confidence: null,
              source: 'human',
              review_state: 'confirmed',
              created_at: '2026-09-09T12:00:00Z',
              code: 'BOX-01',
              display_name: 'Box',
              brand: 'Acme',
            },
          ],
        };
      }
      if (text.includes('from public.media_assets')) {
        return { rows: [{ id: VALID_UUID }] };
      }
      if (text.includes('from public.verity_products')) {
        return { rows: [{ id: 'prod-999', code: 'BOX-01', display_name: 'Box' }] };
      }
      return { rows: [] };
    });

    const result = await attachMediaAssetProduct(
      { mediaAssetId: VALID_UUID, sku: 'BOX-01', role: allowedRole },
      client
    );
    assert.equal(result.role, allowedRole);
  }
});
