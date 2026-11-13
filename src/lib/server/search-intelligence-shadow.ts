import { createHmac, randomBytes } from 'node:crypto';

import { buildSearchPlan } from './search-intelligence-plan';

export interface SearchShadowTelemetry {
  event: 'search_shadow_telemetry';
  query_hash: string;
  query_length: number;
  latency_ms: number;
  lexical_exhausted: boolean;
  semantic_rescued: boolean;
  semantic_active: boolean;
  candidate_count: number;
  shadow_topk_ids: string[];
  baseline_topk_ids: string[];
  overlap_count: number;
  recovery_stage: string;
  error?: string;
}

export interface ShadowIntelligenceRunOptions {
  enableSemanticOnExhausted: boolean;
  semanticEligible: boolean;
}

export interface RunSearchShadowOptions {
  query: string;
  baselineData: Array<{ id: string }>;
  runIntelligence: (options: ShadowIntelligenceRunOptions) => Promise<{
    data: Array<{ id: string }>;
    total: number;
    recoveryStageUsed?: string;
    semanticActive?: boolean;
  }>;
  maxConcurrentTasks?: number;
  timeoutMs?: number;
  topK?: number;
  logger?: (payload: SearchShadowTelemetry) => void;
  now?: () => number;
  telemetryKey?: string;
}

// Per Issue #38 item 4 & Review Condition 1.3:
// When VERITY_SEARCH_TELEMETRY_KEY is set, use it as HMAC key.
// When unset, use an ephemeral per-process random key so fingerprints are NOT
// stable or dictionary-attackable across processes, and no fake public salt is hardcoded.
const PROCESS_EPHEMERAL_KEY: string = randomBytes(32).toString('hex');

export function computeQueryHash(query: string, key?: string): string {
  const hmacKey = key || process.env.VERITY_SEARCH_TELEMETRY_KEY || PROCESS_EPHEMERAL_KEY;
  return createHmac('sha256', hmacKey).update(query.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function computeTopKOverlap(
  baselineIds: string[],
  shadowIds: string[],
  topK: number = 10,
): { baseline_topk_ids: string[]; shadow_topk_ids: string[]; overlap_count: number } {
  const baseline_topk_ids = baselineIds.slice(0, topK);
  const shadow_topk_ids = shadowIds.slice(0, topK);
  const baselineSet = new Set(baseline_topk_ids);
  const overlap_count = shadow_topk_ids.filter((id) => baselineSet.has(id)).length;

  return {
    baseline_topk_ids,
    shadow_topk_ids,
    overlap_count,
  };
}

const defaultLogger = (payload: SearchShadowTelemetry): void => {
  console.info('[search-shadow]', JSON.stringify(payload));
};

// Review Condition 1.2: Bound concurrent in-flight shadow tasks to protect
// database and worker resources under high traffic. Note: stopping awaiting on
// timeout stops waiting on the response, but node-postgres does not cancel
// the running Postgres query on its socket.
export const DEFAULT_MAX_CONCURRENT_SHADOW_TASKS = 2;
let activeShadowTasks = 0;

export function getActiveShadowTaskCount(): number {
  return activeShadowTasks;
}

export function resetActiveShadowTaskCountForTests(): void {
  activeShadowTasks = 0;
}

export async function runSearchShadow(
  options: RunSearchShadowOptions,
): Promise<SearchShadowTelemetry> {
  const {
    query,
    baselineData = [],
    runIntelligence,
    maxConcurrentTasks = Number(process.env.VERITY_SEARCH_SHADOW_MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENT_SHADOW_TASKS,
    timeoutMs = Number(process.env.VERITY_SEARCH_SHADOW_TIMEOUT_MS) || 2000,
    topK = 10,
    logger = defaultLogger,
    now = Date.now,
    telemetryKey,
  } = options;

  const startTime = now();
  const query_hash = computeQueryHash(query, telemetryKey);
  const baseline_topk_ids = baselineData.slice(0, topK).map((item) => item.id);

  // Semaphore / Concurrency bounding: drop shadow task if too many in flight
  if (activeShadowTasks >= maxTasks(maxConcurrentTasks)) {
    const telemetry: SearchShadowTelemetry = {
      event: 'search_shadow_telemetry',
      query_hash,
      query_length: query.length,
      latency_ms: 0,
      lexical_exhausted: false,
      semantic_rescued: false,
      semantic_active: false,
      candidate_count: 0,
      shadow_topk_ids: [],
      baseline_topk_ids,
      overlap_count: 0,
      recovery_stage: 'SHADOW_THROTTLED',
      error: 'MAX_CONCURRENT_SHADOW_TASKS_EXCEEDED',
    };
    try {
      logger(telemetry);
    } catch {
      // Logger errors must never crash caller
    }
    return telemetry;
  }

  // Issue #38 item 2: consume SearchPlan.semanticEligible
  const plan = buildSearchPlan(query);
  const semanticEligible = Boolean(plan.semanticEligible);

  activeShadowTasks++;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`SHADOW_TIMEOUT_${timeoutMs}MS`));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    const intelligent = await Promise.race([
      runIntelligence({
        enableSemanticOnExhausted: semanticEligible,
        semanticEligible,
      }),
      timeoutPromise,
    ]);

    if (timer) {
      clearTimeout(timer);
    }

    const latency_ms = Math.max(0, Math.round(now() - startTime));
    const shadow_topk_ids = (intelligent.data || []).slice(0, topK).map((item) => item.id);
    const baselineSet = new Set(baseline_topk_ids);
    const overlap_count = shadow_topk_ids.filter((id) => baselineSet.has(id)).length;

    const isLexicalExhausted = intelligent.recoveryStageUsed === 'EXHAUSTED';
    const hasCandidates = Array.isArray(intelligent.data) && intelligent.data.length > 0;
    const isSemanticRescued = isLexicalExhausted && hasCandidates && Boolean(intelligent.semanticActive);

    const telemetry: SearchShadowTelemetry = {
      event: 'search_shadow_telemetry',
      query_hash,
      query_length: query.length,
      latency_ms,
      lexical_exhausted: isLexicalExhausted,
      semantic_rescued: isSemanticRescued,
      semantic_active: Boolean(intelligent.semanticActive),
      candidate_count: Array.isArray(intelligent.data) ? intelligent.data.length : (intelligent.total || 0),
      shadow_topk_ids,
      baseline_topk_ids,
      overlap_count,
      recovery_stage: intelligent.recoveryStageUsed || 'UNKNOWN',
    };

    try {
      logger(telemetry);
    } catch {
      // Logger errors must never crash caller
    }

    return telemetry;
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }

    const latency_ms = Math.max(0, Math.round(now() - startTime));
    const isTimeout = error instanceof Error && error.message.startsWith('SHADOW_TIMEOUT');

    const telemetry: SearchShadowTelemetry = {
      event: 'search_shadow_telemetry',
      query_hash,
      query_length: query.length,
      latency_ms,
      lexical_exhausted: false,
      semantic_rescued: false,
      semantic_active: false,
      candidate_count: 0,
      shadow_topk_ids: [],
      baseline_topk_ids,
      overlap_count: 0,
      recovery_stage: isTimeout ? 'TIMEOUT' : 'ERROR',
      error: error instanceof Error ? error.message : String(error),
    };

    try {
      logger(telemetry);
    } catch {
      // Logger errors must never crash caller
    }

    return telemetry;
  } finally {
    activeShadowTasks--;
  }
}

function maxTasks(val: number): number {
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_MAX_CONCURRENT_SHADOW_TASKS;
}
