import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import pg from 'pg';
import sharp from 'sharp';
import {
  evaluateReviewCandidate,
  isSafeDecisionEntry,
  validateApprovalPayload,
} from './review-assist-policy.mjs';

const { Pool } = pg;
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_APPROVALS = 5;
const MAX_LIMIT = 20;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const args = { mode: 'dry-run', limit: DEFAULT_LIMIT, maxApprovals: DEFAULT_MAX_APPROVALS };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--execute') args.mode = 'execute';
    else if (value === '--dry-run') args.mode = 'dry-run';
    else if (value === '--all') args.all = true;
    else if (value === '--headful') args.headful = true;
    else if (value === '--confirm-production') args.confirmProduction = true;
    else if (value === '--base-url') args.baseUrl = argv[++i];
    else if (value === '--cursor') args.cursor = argv[++i];
    else if (value === '--limit') args.limit = Number(argv[++i]);
    else if (value === '--max-approvals') args.maxApprovals = Number(argv[++i]);
    else if (value === '--decisions') args.decisions = argv[++i];
    else if (value === '--report') args.report = argv[++i];
    else if (value === '--output') args.output = argv[++i];
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function printHelp() {
  console.log(`Review Assist (dry-run by default)

Required environment:
  REVIEW_ASSIST_BASE_URL
  REVIEW_ASSIST_EMAIL
  REVIEW_ASSIST_PASSWORD

Execute-only environment:
  REVIEW_ASSIST_READONLY_DATABASE_URL
  REVIEW_ASSIST_EXPECTED_DATABASE
  REVIEW_ASSIST_REVIEWER_USER_ID

Commands:
  node scripts/review-assist.mjs --dry-run --limit 10
  node scripts/review-assist.mjs --dry-run --all
  node scripts/review-assist.mjs --dry-run --limit 50 --cursor <review-queue-cursor>
  node scripts/review-assist.mjs --execute --report <dry-run-report.json> --decisions <decisions.json> --max-approvals 5 --confirm-production

Safety:
  - only role=reviewer is accepted;
  - dry-run never clicks an approval action;
  - execute requires explicit production confirmation and a read-only DB URL;
  - execute is capped at 20 inspected items and 5 approvals unless overridden;
  - execute binds decisions to the exact dry-run report and revalidates every item immediately before click;
  - all approvals are sequential and stop on the first postcondition failure.
`);
}

function nowId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function safeNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeUrl(baseUrl, rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const url = new URL(rawUrl, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported image URL protocol: ${url.protocol}`);
  return url;
}

function publicUrlShape(rawUrl, baseUrl) {
  try {
    const url = normalizeUrl(baseUrl, rawUrl);
    return { host: url.hostname, pathname: url.pathname };
  } catch {
    return { host: null, pathname: null };
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

function reviewSnapshot(item, imageSha256) {
  const asset = item?.asset || {};
  return {
    queue_id: item?.id || null,
    asset_id: asset.id || null,
    image_sha256: imageSha256 || null,
    asset: {
      title: asset.title || '',
      sku: asset.sku || null,
      brand: asset.brand || null,
      category: asset.category || null,
      space: asset.space || null,
      status: asset.status || null,
      permission: asset.permission || null,
      media_type: asset.media_type || null,
      dimensions: asset.dimensions || null,
      ai_flags: asset.ai_flags || {},
      has_open_report: asset.has_open_report === true,
      needs_post_production: asset.needs_post_production === true,
    },
    sku_match: item?.sku_match || {},
  };
}

function fingerprintReviewItem(item, imageSha256) {
  return createHash('sha256').update(stableJson(reviewSnapshot(item, imageSha256))).digest('hex');
}

function queueIdFromDecisionUrl(rawUrl) {
  try {
    const match = new URL(rawUrl).pathname.match(/\/api\/review-queue\/([^/]+)\/decision$/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function getJson(request, path) {
  const response = await request.get(path, { timeout: DEFAULT_TIMEOUT_MS, failOnStatusCode: false });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok()) {
    throw new Error(`${path} returned HTTP ${response.status()}${body?.error?.code ? ` (${body.error.code})` : ''}`);
  }
  return body;
}

async function login(page, email, password, baseUrl) {
  await page.goto(`${baseUrl}/login?returnUrl=%2Freview`, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.waitForURL((url) => ['/review', '/library'].includes(url.pathname), { timeout: DEFAULT_TIMEOUT_MS });
}

async function inspectRemoteImage(request, baseUrl, rawUrl) {
  const output = {
    checked: true,
    ok: false,
    decoded: false,
    bytes: null,
    content_type: null,
    sha256: null,
    format: null,
    width: null,
    height: null,
    error: null,
  };
  if (!rawUrl) {
    output.error = 'No image URL.';
    return output;
  }

  let url;
  try { url = normalizeUrl(baseUrl, rawUrl); } catch (error) {
    output.error = error instanceof Error ? error.message : String(error);
    return output;
  }

  try {
    const response = await request.get(url.href, { timeout: DEFAULT_TIMEOUT_MS, failOnStatusCode: false });
    output.content_type = response.headers()['content-type'] || null;
    if (!response.ok()) {
      output.error = `Image endpoint returned HTTP ${response.status()}.`;
      return output;
    }
    output.content_type = response.headers()['content-type'] || null;
    const body = await response.body();
    output.bytes = body.byteLength;
    if (output.bytes > MAX_IMAGE_BYTES) {
      output.error = `Image exceeds ${MAX_IMAGE_BYTES} bytes.`;
      return output;
    }
    output.sha256 = createHash('sha256').update(body).digest('hex');
    const metadata = await sharp(body).metadata();
    output.format = metadata.format || null;
    output.width = metadata.width || null;
    output.height = metadata.height || null;
    output.decoded = Boolean(output.format && output.width && output.height);
    output.ok = output.decoded;
    if (!output.decoded) output.error = 'Image decoded without usable dimensions.';
  } catch (error) {
    output.error = error instanceof Error ? error.message : String(error);
  }
  return output;
}

function dimensionsMismatch(asset, inspection) {
  const dimensions = asset?.dimensions && typeof asset.dimensions === 'object' ? asset.dimensions : {};
  const expectedWidth = Number(dimensions.width || 0);
  const expectedHeight = Number(dimensions.height || 0);
  if (!expectedWidth || !expectedHeight || !inspection.width || !inspection.height) return false;
  return expectedWidth !== inspection.width || expectedHeight !== inspection.height;
}

async function inspectReviewPage(page, item, screenshotPath) {
  await page.goto(`${new URL(page.url()).origin}/review?assetId=${encodeURIComponent(item.asset.id)}`, {
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const frame = page.getByTestId('review-image-frame');
  await frame.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  const image = frame.locator('img').first();
  await image.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="review-image-frame"] img');
    return Boolean(element && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0);
  }, undefined, { timeout: DEFAULT_TIMEOUT_MS });
  const browserImage = await image.evaluate((element) => ({
    src: element.getAttribute('src') || '',
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
    complete: element.complete,
  }));
  await page.screenshot({ path: screenshotPath, fullPage: false });
  return {
    browser_image: {
      url: publicUrlShape(browserImage.src, page.url()),
      natural_width: browserImage.naturalWidth,
      natural_height: browserImage.naturalHeight,
      complete: browserImage.complete,
    },
    body_text_excerpt: (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 2_000),
  };
}

async function poolFromEnvironment() {
  const connectionString = process.env.REVIEW_ASSIST_READONLY_DATABASE_URL;
  if (!connectionString) throw new Error('REVIEW_ASSIST_READONLY_DATABASE_URL is required for execute mode.');
  const expectedDatabase = process.env.REVIEW_ASSIST_EXPECTED_DATABASE;
  if (!expectedDatabase) throw new Error('REVIEW_ASSIST_EXPECTED_DATABASE is required for execute mode.');
  const pool = new Pool({ connectionString, max: 1, idleTimeoutMillis: 5_000, connectionTimeoutMillis: DEFAULT_TIMEOUT_MS, statement_timeout: DEFAULT_TIMEOUT_MS });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(
      `select current_database() as database_name,
              current_user as database_user,
              current_setting('transaction_read_only') as transaction_read_only,
              r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls
         from pg_roles r
        where r.rolname = current_user`
    );
    const row = result.rows[0];
    if (!row || String(row.database_name) !== String(expectedDatabase)) throw new Error('Read-only DB identity does not match REVIEW_ASSIST_EXPECTED_DATABASE.');
    if (row.transaction_read_only !== 'on') throw new Error('Review assist DB transaction is not read-only.');
    if (row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolbypassrls) throw new Error('Review assist DB role has elevated privileges; refusing to use it.');
    await client.query('COMMIT');
    return pool;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* best effort */ }
    await pool.end().catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readDbSnapshot(pool, queueId, assetId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(
      `select a.review_state, a.sku, a.file_url, a.thumbnail_url,
              jsonb_build_object(
                'title', a.title, 'sku', a.sku, 'brand', a.brand,
                'category', a.category, 'space', a.space, 'status', a.status,
                'permission', a.permission, 'suggested_caption', a.suggested_caption,
                'author', a.author, 'copyright', a.copyright, 'credit', a.credit,
                'description', a.description, 'keywords', to_jsonb(a.keywords)
              ) as metadata_snapshot,
              q.status as queue_status, q.reviewed_by::text as reviewed_by,
              q.reviewed_at,
              (select count(*)::int from public.media_usages u
                where u.media_asset_id = a.id and u.channel = 'review_approved') as review_usage_count,
              (select count(*)::int from public.review_correction_log l
                where l.media_asset_id = a.id) as correction_count,
              (select count(*)::int from public.metadata_few_shot_examples f
                where f.source_media_asset_id = a.id) as few_shot_count,
              (select count(*)::int from public.sku_references r
                where r.source_media_asset_id = a.id) as sku_reference_count,
              (select count(*)::int from public.reference_embeddings re
                join public.sku_references r on r.reference_id = re.reference_id
                where r.source_media_asset_id = a.id) as reference_embedding_count
         from public.media_assets a
         left join public.review_queue q on q.id = $1 and q.media_asset_id = a.id
        where a.id = $2
        limit 1`,
      [queueId, assetId]
    );
    await client.query('COMMIT');
    const row = result.rows[0];
    if (!row) return { ok: false, error: 'DB asset row missing.' };
    if (!userId) return { ok: false, error: 'DB reviewer identity is missing.', row };
    if (row.reviewed_by && String(row.reviewed_by) !== String(userId)) {
      return { ok: false, error: 'DB reviewed_by does not match the reviewer session.' , row };
    }
    return { ok: true, row: {
      review_state: row.review_state,
      sku: row.sku,
      file_url: row.file_url,
      thumbnail_url: row.thumbnail_url,
      metadata_snapshot: row.metadata_snapshot,
      queue_status: row.queue_status,
      reviewed_by: row.reviewed_by,
      reviewed_at: row.reviewed_at,
      review_usage_count: Number(row.review_usage_count || 0),
      correction_count: Number(row.correction_count || 0),
      few_shot_count: Number(row.few_shot_count || 0),
      sku_reference_count: Number(row.sku_reference_count || 0),
      reference_embedding_count: Number(row.reference_embedding_count || 0),
    }};
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* best effort */ }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

function assertNoUnexpectedSideEffects(before, after) {
  const failures = [];
  if (stableJson(before.row.metadata_snapshot) !== stableJson(after.row.metadata_snapshot)) failures.push('DB_METADATA_CHANGED');
  for (const field of ['correction_count', 'few_shot_count', 'sku_reference_count', 'reference_embedding_count']) {
    if (before.row[field] !== after.row[field]) failures.push(`DB_${field.toUpperCase()}_CHANGED`);
  }
  if (after.row.review_usage_count < before.row.review_usage_count + 1) failures.push('DB_REVIEW_USAGE_NOT_RECORDED');
  return failures;
}

async function checkApprovalPostconditions({ request, dbPool, target, userId, baseUrl }) {
  const failures = [];
  let apiAsset = null;
  let dbAfter = null;
  let r2After = null;
  try {
    apiAsset = (await getJson(request, `/api/media/${encodeURIComponent(target.entry.asset_id)}`))?.data || null;
  } catch (error) {
    failures.push(`API_POSTCONDITION_FAILED:${error instanceof Error ? error.message : String(error)}`);
  }
  if (apiAsset?.review_state !== 'approved') failures.push('API_REVIEW_STATE_NOT_APPROVED');
  if (String(apiAsset?.sku || '').trim().toLowerCase() !== String(target.item.asset?.sku || '').trim().toLowerCase()) failures.push('API_SKU_CHANGED');
  if (!Array.isArray(apiAsset?.media_usages) || !apiAsset.media_usages.some((usage) => usage?.channel === 'review_approved')) failures.push('API_REVIEW_USAGE_MISSING');

  dbAfter = await readDbSnapshot(dbPool, target.entry.queue_id, target.entry.asset_id, userId);
  if (!dbAfter.ok) failures.push(`DB_POSTCONDITION_FAILED:${dbAfter.error}`);
  else {
    if (dbAfter.row.queue_status !== 'approved' || dbAfter.row.review_state !== 'approved') failures.push('DB_REVIEW_STATE_NOT_APPROVED');
    if (String(dbAfter.row.reviewed_by || '') !== String(userId)) failures.push('DB_REVIEWED_BY_MISMATCH');
    failures.push(...assertNoUnexpectedSideEffects(target.dbBefore, dbAfter));
  }

  const postconditionUrl = apiAsset?.file_url || apiAsset?.thumbnail_url;
  if (!postconditionUrl) {
    failures.push('R2_IMAGE_URL_MISSING');
  } else {
    r2After = await inspectRemoteImage(request, baseUrl, postconditionUrl);
    if (!r2After.ok || !r2After.decoded) failures.push('R2_IMAGE_POSTCONDITION_FAILED');
    if (target.entry.inspection?.sha256 && r2After.sha256 && target.entry.inspection.sha256 !== r2After.sha256) failures.push('R2_IMAGE_CHANGED');
  }

  const settled = dbAfter?.ok === true
    && dbAfter.row.queue_status === 'approved'
    && dbAfter.row.review_state === 'approved';
  return { ok: failures.length === 0, settled, failures, apiAsset, dbAfter, r2After };
}

async function waitForApprovalPostconditions(args, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await checkApprovalPostconditions(args);
    if (last.ok) return last;
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (Date.now() < deadline);
  return {
    ...(last || { ok: false, settled: false, failures: [] }),
    ok: false,
    settled: false,
    failures: [...(last?.failures || []), 'POSTCONDITION_TIMEOUT'],
  };
}

async function fetchQueue(request, limit, cursor = null) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const body = await getJson(request, `/api/review-queue?${query.toString()}`);
  if (!Array.isArray(body?.data)) throw new Error('Review queue response does not contain data[].');
  return body.data;
}

async function fetchAllQueue(request, pageSize = 100, initialCursor = null) {
  const entries = [];
  let cursor = initialCursor;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) query.set('cursor', cursor);
    const body = await getJson(request, `/api/review-queue?${query.toString()}`);
    if (!Array.isArray(body?.data)) throw new Error('Review queue response does not contain data[].');
    entries.push(...body.data);
    if (!body.has_more) return entries;
    if (!body.next_cursor || body.next_cursor === cursor) throw new Error('Review queue pagination did not advance.');
    cursor = body.next_cursor;
  }
  throw new Error('Review queue pagination exceeded the safety page limit.');
}

async function revalidateItem(request, baseUrl, queueId, expectedEntry) {
  const queue = await fetchQueue(request, 100);
  const current = queue.find((item) => String(item.id) === String(queueId));
  if (!current) return { ok: false, error: 'Queue item is no longer pending.' };
  let detail = null;
  try {
    detail = (await getJson(request, `/api/media/${encodeURIComponent(current.asset?.id || '')}`))?.data || null;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!detail) return { ok: false, error: 'Asset detail is missing.' };
  const item = { ...current, asset: { ...(current.asset || {}), ...detail } };
  const image = await inspectRemoteImage(request, baseUrl, item.asset.file_url || item.asset.thumbnail_url);
  image.dimensionMismatch = dimensionsMismatch(item.asset, image);
  const inspection = { ...(expectedEntry?.inspection || {}), ...image, detail_checked: true, detail_ok: true, detail_error: null };
  const fingerprint = fingerprintReviewItem(item, image.sha256);
  if (expectedEntry && (fingerprint !== expectedEntry.preflight_fingerprint || image.sha256 !== expectedEntry.preflight_image_sha256)) {
    return { ok: false, error: 'Preflight evidence changed.' };
  }
  const policy = evaluateReviewCandidate(item, inspection);
  return { ok: true, item, inspection, fingerprint, policy };
}

async function loadDecisions(path) {
  if (!path) throw new Error('--decisions is required in execute mode.');
  const raw = JSON.parse(await readFile(resolve(path), 'utf8'));
  const decisions = Array.isArray(raw) ? raw : raw?.decisions;
  if (!Array.isArray(decisions)) throw new Error('Decision manifest must be an array or contain decisions[].');
  if (!raw?.run_id) throw new Error('Decision manifest must contain the dry-run run_id.');
  return { runId: raw?.run_id || null, decisions };
}

async function loadDryRunReport(path) {
  if (!path) throw new Error('--report is required in execute mode.');
  const raw = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (raw?.mode !== 'dry-run' || !raw?.run_id || !Array.isArray(raw?.entries)) {
    throw new Error('The source report must be a dry-run report with run_id and entries[].');
  }
  return raw;
}

async function inspectItems({ page, request, baseUrl, queue, outputDir }) {
  const entries = [];
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const asset = item?.asset || {};
    const id = String(asset.id || item.id || `unknown-${index + 1}`);
    let detail = null;
    let detailError = null;
    try {
      detail = (await getJson(request, `/api/media/${encodeURIComponent(id)}`))?.data || null;
    } catch (error) {
      detailError = error instanceof Error ? error.message : String(error);
    }
    const candidateItem = detail && typeof detail === 'object'
      ? { ...item, asset: { ...asset, ...detail } }
      : item;
    const originalInspection = await inspectRemoteImage(request, baseUrl, asset.file_url || asset.thumbnail_url);
    originalInspection.dimensionMismatch = dimensionsMismatch(asset, originalInspection);
    const screenshotPath = resolve(outputDir, `${String(index + 1).padStart(2, '0')}-${id}.png`);
    let pageInspection;
    let pageError = null;
    try {
      pageInspection = await inspectReviewPage(page, item, screenshotPath);
    } catch (error) {
      pageError = error instanceof Error ? error.message : String(error);
    }
    const inspection = {
      ...originalInspection,
      detail_checked: true,
      detail_ok: Boolean(detail),
      detail_error: detailError,
      page: pageInspection || null,
      page_error: pageError,
    };
    if (pageError) inspection.error = pageError;
    const policy = evaluateReviewCandidate(candidateItem, inspection);
    const preflightFingerprint = fingerprintReviewItem(candidateItem, originalInspection.sha256);
    entries.push({
      index: index + 1,
      queue_id: candidateItem?.id || null,
      asset_id: candidateItem.asset?.id || null,
      asset: {
        title: candidateItem.asset.title || '',
        sku: candidateItem.asset.sku || null,
        brand: candidateItem.asset.brand || null,
        category: candidateItem.asset.category || null,
        space: candidateItem.asset.space || null,
        status: candidateItem.asset.status || null,
        permission: candidateItem.asset.permission || null,
        media_type: candidateItem.asset.media_type || null,
        dimensions: candidateItem.asset.dimensions || null,
        ai_flags: candidateItem.asset.ai_flags || {},
        has_open_report: candidateItem.asset.has_open_report === true,
        needs_post_production: Boolean(candidateItem.asset.needs_post_production),
        image_url: publicUrlShape(candidateItem.asset.file_url || candidateItem.asset.thumbnail_url, baseUrl),
        guide_url: publicUrlShape(candidateItem.asset.guide_url, baseUrl),
      },
      sku_match: candidateItem?.sku_match || {},
      inspection,
      policy,
      preflight_fingerprint: preflightFingerprint,
      preflight_image_sha256: originalInspection.sha256,
      visual_verdict: 'pending',
      confirmed_sku: null,
      operator_confirmed: false,
      screenshot: pageInspection ? screenshotPath : null,
    });
  }
  return entries;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  const baseUrl = args.baseUrl || process.env.REVIEW_ASSIST_BASE_URL;
  const email = process.env.REVIEW_ASSIST_EMAIL;
  const password = process.env.REVIEW_ASSIST_PASSWORD;
  if (!baseUrl || !email || !password) throw new Error('REVIEW_ASSIST_BASE_URL, REVIEW_ASSIST_EMAIL and REVIEW_ASSIST_PASSWORD are required.');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('REVIEW_ASSIST_BASE_URL must use http or https.');
  if (args.all && args.mode === 'execute') throw new Error('--all is available only in dry-run mode.');
  const limit = args.all ? 100 : Math.min(Math.max(Math.trunc(safeNumber(args.limit, DEFAULT_LIMIT)), 1), MAX_LIMIT);
  const maxApprovals = Math.min(Math.max(Math.trunc(safeNumber(args.maxApprovals, DEFAULT_MAX_APPROVALS)), 1), MAX_LIMIT);
  if (args.mode === 'execute' && !args.confirmProduction && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
    throw new Error('Execute mode on a non-local host requires --confirm-production.');
  }
  if (args.mode === 'execute' && !args.decisions) throw new Error('Execute mode requires --decisions <manifest.json>.');
  if (args.mode === 'execute' && !args.report) throw new Error('Execute mode requires --report <dry-run-report.json>.');
  if (args.mode === 'execute' && !process.env.REVIEW_ASSIST_READONLY_DATABASE_URL) throw new Error('Execute mode requires REVIEW_ASSIST_READONLY_DATABASE_URL.');
  if (args.mode === 'execute' && !process.env.REVIEW_ASSIST_EXPECTED_DATABASE) throw new Error('Execute mode requires REVIEW_ASSIST_EXPECTED_DATABASE.');
  if (args.mode === 'execute' && !process.env.REVIEW_ASSIST_REVIEWER_USER_ID) throw new Error('Execute mode requires REVIEW_ASSIST_REVIEWER_USER_ID.');

  const runId = `${args.mode}-${nowId()}`;
  const outputDir = resolve(args.output || `test-results/review-assist/${runId}`);
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: !args.headful });
  const context = await browser.newContext({ baseURL: base.origin, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const mutationEvents = [];
  let activeMutation = null;
  let approvalClickArmed = false;
  let approvalRequestSeen = false;
  let mutationBlock = null;

  let dbPool = null;
  try {
    await login(page, email, password, base.origin);
    const request = context.request;
    const session = await getJson(request, '/api/auth/session');
    if (session?.user?.role !== 'reviewer') {
      throw new Error(`Review assist requires role=reviewer; received ${session?.user?.role || 'unknown'}.`);
    }
    if (args.mode === 'execute' && String(session?.user?.id || '') !== String(process.env.REVIEW_ASSIST_REVIEWER_USER_ID)) {
      throw new Error('The authenticated session does not match REVIEW_ASSIST_REVIEWER_USER_ID.');
    }
    if (args.mode === 'execute' && String(session?.user?.email || '').trim().toLowerCase() !== String(email).trim().toLowerCase()) {
      throw new Error('The authenticated session email does not match REVIEW_ASSIST_EMAIL.');
    }
    await page.route('**/*', async (route) => {
      const method = route.request().method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        await route.fallback();
        return;
      }
      const pathname = new URL(route.request().url()).pathname;
      const isDecision = /\/api\/review-queue\/[^/]+\/decision$/.test(pathname);
      const isBlockedReviewMutation = /\/api\/review-queue\/batch-decision$/.test(pathname)
        || /\/api\/review-queue\/[^/]+\/reopen$/.test(pathname);
      if (isBlockedReviewMutation) {
        mutationBlock = { reason: 'NON_SINGLE_REVIEW_MUTATION_BLOCKED', method, url: route.request().url() };
        await route.abort('blockedbyclient');
        return;
      }
      if (!isDecision) {
        mutationBlock = { reason: 'UNEXPECTED_API_WRITE_BLOCKED', method, url: route.request().url() };
        await route.abort('blockedbyclient');
        return;
      }
      if (method !== 'POST') {
        mutationBlock = { reason: 'UNEXPECTED_DECISION_METHOD_BLOCKED', method, url: route.request().url() };
        await route.abort('blockedbyclient');
        return;
      }
      if (!activeMutation || !approvalClickArmed) {
        mutationBlock = { reason: 'APPROVAL_NOT_CLICK_ARMED', url: route.request().url() };
        await route.abort('blockedbyclient');
        return;
      }
      if (approvalRequestSeen) {
        mutationBlock = { reason: 'MULTIPLE_APPROVAL_REQUESTS', url: route.request().url() };
        await route.abort('blockedbyclient');
        return;
      }
      approvalRequestSeen = true;
      const requestQueueId = queueIdFromDecisionUrl(route.request().url());
      if (requestQueueId !== String(activeMutation.queueId)) {
        mutationBlock = {
          reason: 'WRONG_QUEUE_ITEM_MUTATION',
          expected_queue_id: String(activeMutation.queueId),
          received_queue_id: requestQueueId,
        };
        await route.abort('blockedbyclient');
        return;
      }
      let payload = null;
      try { payload = route.request().postDataJSON(); } catch { payload = null; }
      const result = validateApprovalPayload(payload, activeMutation.item, activeMutation.decision);
      mutationEvents.push({ queue_id: activeMutation.queueId, payload_summary: {
        decision: payload?.decision || null,
        corrections_count: Array.isArray(payload?.corrections) ? payload.corrections.length : 0,
        product_links_count: Array.isArray(payload?.product_links) ? payload.product_links.length : 0,
      }, validation: result });
      if (!result.ok) {
        mutationBlock = { reason: 'UNSAFE_MUTATION_PAYLOAD', blockers: result.blockers };
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const queue = args.all ? await fetchAllQueue(request, 100, args.cursor || null) : await fetchQueue(request, limit, args.cursor || null);
    const entries = await inspectItems({ page, request, baseUrl: base.origin, queue, outputDir });
    const report = {
      version: 1,
      run_id: runId,
      mode: args.mode,
      started_at: new Date().toISOString(),
      base_url: base.origin,
      reviewer: { id: session.user.id || null, email: session.user.email || email, role: session.user.role },
      controls: { limit, all: Boolean(args.all), max_approvals: maxApprovals, sequential: true, dry_run: args.mode === 'dry-run', circuit_breaker: true },
      entries,
      mutation_events: mutationEvents,
      status: args.mode === 'dry-run' ? 'DRY_RUN_COMPLETE' : 'EXECUTE_PENDING',
    };
    await writeFile(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(resolve(outputDir, 'decisions.template.json'), JSON.stringify({
      run_id: runId,
      decisions: entries.map((entry) => ({
        queue_id: entry.queue_id,
        asset_id: entry.asset_id,
        visual_verdict: 'pending',
        confirmed_sku: null,
        operator_confirmed: false,
        preflight_fingerprint: entry.preflight_fingerprint,
        preflight_image_sha256: entry.preflight_image_sha256,
      })),
    }, null, 2));

    if (args.mode === 'dry-run') {
      console.log(JSON.stringify({ success: true, mode: 'dry-run', run_id: runId, output_dir: outputDir, inspected: entries.length, eligible_by_machine_policy: entries.filter((entry) => entry.policy.eligible).length }, null, 2));
      return;
    }

    dbPool = await poolFromEnvironment();
    const decisions = await loadDecisions(args.decisions);
    const sourceReport = await loadDryRunReport(args.report);
    if (decisions.runId !== sourceReport.run_id) {
      throw new Error(`Decision manifest run_id ${decisions.runId} does not match source report ${sourceReport.run_id}.`);
    }
    const sourceByQueueId = new Map(sourceReport.entries.map((entry) => [String(entry.queue_id), entry]));
    for (const decision of decisions.decisions) {
      if (decision.visual_verdict !== 'exact') continue;
      const source = sourceByQueueId.get(String(decision.queue_id));
      if (!source || String(decision.asset_id) !== String(source.asset_id)
        || decision.preflight_fingerprint !== source.preflight_fingerprint
        || decision.preflight_image_sha256 !== source.preflight_image_sha256) {
        throw new Error(`Decision ${decision.queue_id} is not bound to the supplied dry-run report.`);
      }
    }
    const decisionByQueueId = new Map(decisions.decisions.map((entry) => [String(entry.queue_id), entry]));
    const selected = [];
    for (const entry of entries) {
      const decision = decisionByQueueId.get(String(entry.queue_id));
      if (!decision) continue;
      if (String(decision.asset_id) !== String(entry.asset_id || '')) {
        throw new Error(`Decision ${entry.queue_id} does not match the current asset_id. Nothing was mutated.`);
      }
      if (decision.visual_verdict === 'skip' || decision.visual_verdict === 'pending') continue;
      const currentReview = await revalidateItem(request, base.origin, entry.queue_id, entry);
      if (!currentReview.ok) throw new Error(`Preflight revalidation failed for ${entry.queue_id}: ${currentReview.error}`);
      const candidate = {
        ...entry,
        asset: currentReview.item.asset,
        inspection: currentReview.inspection,
        policy: currentReview.policy,
        preflight_fingerprint: currentReview.fingerprint,
      };
      if (!isSafeDecisionEntry({ ...decision, preflight_fingerprint: decision.preflight_fingerprint }, candidate)) {
        throw new Error(`Decision ${entry.queue_id} is not safe for execution; visual confirmation, SKU or machine policy failed.`);
      }
      const dbBefore = await readDbSnapshot(dbPool, entry.queue_id, entry.asset_id, session.user.id);
      if (!dbBefore.ok) throw new Error(`DB precondition failed for ${entry.queue_id}: ${dbBefore.error}`);
      if (dbBefore.row.queue_status !== 'pending' || dbBefore.row.review_state !== 'pending') {
        throw new Error(`DB precondition failed for ${entry.queue_id}: item is no longer pending.`);
      }
      selected.push({ entry: candidate, decision, item: currentReview.item, dbBefore });
      if (selected.length >= maxApprovals) break;
    }
    if (selected.length === 0) throw new Error('No explicitly confirmed safe decisions were found. Nothing was mutated.');

    let approved = 0;
    let circuitBreaker = null;
    for (const target of selected) {
      const latestReview = await revalidateItem(request, base.origin, target.entry.queue_id, target.entry);
      if (!latestReview.ok) {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: `IMMEDIATE_REVALIDATION_FAILED:${latestReview.error}` };
        break;
      }
      target.item = latestReview.item;
      target.entry = {
        ...target.entry,
        asset: latestReview.item.asset,
        inspection: latestReview.inspection,
        policy: latestReview.policy,
        preflight_fingerprint: latestReview.fingerprint,
      };
      const latestDbBefore = await readDbSnapshot(dbPool, target.entry.queue_id, target.entry.asset_id, session.user.id);
      if (!latestDbBefore.ok || latestDbBefore.row.queue_status !== 'pending' || latestDbBefore.row.review_state !== 'pending') {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: `IMMEDIATE_DB_REVALIDATION_FAILED:${latestDbBefore.error || 'item is no longer pending'}` };
        break;
      }
      target.dbBefore = latestDbBefore;
      activeMutation = null;
      approvalClickArmed = false;
      approvalRequestSeen = false;
      mutationBlock = null;
      await page.goto(`${base.origin}/review?assetId=${encodeURIComponent(target.entry.asset_id)}`, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      const approveButton = page.getByRole('button', { name: 'Duyệt & tiếp', exact: true });
      await approveButton.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
      if (await approveButton.isDisabled()) throw new Error(`Approve button is disabled for ${target.entry.queue_id}.`);
      const clickTimeReview = await revalidateItem(request, base.origin, target.entry.queue_id, target.entry);
      if (!clickTimeReview.ok) {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: `CLICK_TIME_REVALIDATION_FAILED:${clickTimeReview.error}` };
        break;
      }
      target.item = clickTimeReview.item;
      target.entry = {
        ...target.entry,
        asset: clickTimeReview.item.asset,
        inspection: clickTimeReview.inspection,
        policy: clickTimeReview.policy,
        preflight_fingerprint: clickTimeReview.fingerprint,
      };
      const clickTimeDbBefore = await readDbSnapshot(dbPool, target.entry.queue_id, target.entry.asset_id, session.user.id);
      if (!clickTimeDbBefore.ok || clickTimeDbBefore.row.queue_status !== 'pending' || clickTimeDbBefore.row.review_state !== 'pending') {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: `CLICK_TIME_DB_REVALIDATION_FAILED:${clickTimeDbBefore.error || 'item is no longer pending'}` };
        break;
      }
      target.dbBefore = clickTimeDbBefore;
      if (await approveButton.isDisabled()) {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: 'APPROVE_BUTTON_DISABLED_AT_CLICK_TIME' };
        break;
      }
      if (mutationBlock) {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: mutationBlock };
        break;
      }
      activeMutation = { queueId: target.entry.queue_id, item: target.item, decision: target.decision };
      approvalClickArmed = true;
      const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/api/review-queue/${target.entry.queue_id}/decision`), { timeout: 5_000 }).catch(() => null);
      let clickError = null;
      try {
        await approveButton.click();
      } catch (error) {
        clickError = error instanceof Error ? error.message : String(error);
      }
      approvalClickArmed = false;
      const response = await responsePromise;
      if (mutationBlock) {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: mutationBlock };
        break;
      }
      if (clickError || !response || !response.ok()) {
        const reconciled = await waitForApprovalPostconditions({ request, dbPool, target, userId: session.user.id, baseUrl: base.origin }, 15_000);
        circuitBreaker = {
          queue_id: target.entry.queue_id,
          reason: clickError
            ? `APPROVAL_CLICK_FAILED:${clickError}`
            : `APPROVAL_HTTP_FAILED_${response?.status?.() || 'NO_RESPONSE'}`,
          postconditions: reconciled,
        };
        break;
      }
      const postconditions = await waitForApprovalPostconditions({ request, dbPool, target, userId: session.user.id, baseUrl: base.origin }, 15_000);
      if (!postconditions.ok) {
        circuitBreaker = { queue_id: target.entry.queue_id, reason: postconditions.failures, postconditions };
        break;
      }
      approved += 1;
      activeMutation = null;
    }
    activeMutation = null;
    const executeResult = {
      ...report,
      status: circuitBreaker ? 'CIRCUIT_BREAKER_STOPPED' : 'EXECUTE_COMPLETE',
      execute: { approved, requested: selected.length, circuit_breaker: circuitBreaker },
      mutation_events: mutationEvents,
    };
    await writeFile(resolve(outputDir, 'execute-report.json'), JSON.stringify(executeResult, null, 2));
    console.log(JSON.stringify({ success: !circuitBreaker, mode: 'execute', run_id: runId, output_dir: outputDir, approved, requested: selected.length, circuit_breaker: circuitBreaker }, null, 2));
    if (circuitBreaker) process.exitCode = 2;
  } finally {
    if (dbPool) await dbPool.end().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
