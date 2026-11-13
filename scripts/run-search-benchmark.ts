#!/usr/bin/env node
/**
 * Canonical Search Benchmark Execution Runner (Issue #42).
 *
 * Reads 211 queries from backend/benchmarks/gold_nlp_search/queries_scaffold.json.
 * Queries the canonical Next.js search engine endpoint (/api/internal/media-search).
 * Saves the actual ranked document IDs to backend/benchmarks/gold_nlp_search/canonical_engine_results.json.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ScaffoldQuery {
  query_id: string;
  query_text: string;
  bucket: string;
  intent: string;
  split: string;
  metadata?: Record<string, any>;
  double_annotated?: boolean;
}

interface ScaffoldPayload {
  scaffold_version: string;
  total_queries: number;
  queries: ScaffoldQuery[];
}

interface RankedQueryResult {
  query_id: string;
  query_text: string;
  bucket: string;
  split: string;
  doc_ids: string[];
  latency_ms: number;
  total_matches: number;
  used_intelligence: boolean;
  recovery_stage?: string;
  semantic_active?: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  let endpoint = process.env.VERITY_SEARCH_ENDPOINT || 'http://127.0.0.1:3020/api/internal/media-search';
  let serviceKey = process.env.VERITY_INTERNAL_SERVICE_KEY || 'verity-internal-mcp-key-dev';
  let actorUserId = process.env.VERITY_ACTOR_USER_ID || '1717f588-2aeb-4bcb-9813-519c1e8c3090';
  let mode: string | undefined = undefined;
  let split: string = 'all';
  let outPath = path.resolve(__dirname, '../backend/benchmarks/gold_nlp_search/canonical_engine_results.json');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--endpoint' && args[i + 1]) {
      endpoint = args[++i];
    } else if (args[i] === '--key' && args[i + 1]) {
      serviceKey = args[++i];
    } else if (args[i] === '--actor' && args[i + 1]) {
      actorUserId = args[++i];
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (args[i] === '--split' && args[i + 1]) {
      split = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outPath = path.resolve(process.cwd(), args[++i]);
    }
  }

  const scaffoldPath = path.resolve(__dirname, '../backend/benchmarks/gold_nlp_search/queries_scaffold.json');
  if (!fs.existsSync(scaffoldPath)) {
    console.error(`[ERROR] Scaffold file not found: ${scaffoldPath}`);
    process.exit(1);
  }

  const scaffoldData: ScaffoldPayload = JSON.parse(fs.readFileSync(scaffoldPath, 'utf-8'));
  const targetQueries = scaffoldData.queries.filter((q) => split === 'all' || q.split === split);

  console.log('================================================================================');
  console.log(`RUNNING CANONICAL SEARCH BENCHMARK ON ${targetQueries.length} QUERIES (Split: ${split}, Mode: ${mode || 'default'})`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Actor:    ${actorUserId}`);
  console.log(`Output:   ${outPath}`);
  console.log('================================================================================');

  const results: RankedQueryResult[] = [];
  let successful = 0;
  let failed = 0;

  for (let idx = 0; idx < targetQueries.length; idx++) {
    const q = targetQueries[idx];
    const t0 = Date.now();

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-key': serviceKey,
          'x-actor-user-id': actorUserId,
        },
        body: JSON.stringify({
          q: q.query_text,
          limit: 10,
          offset: 0,
          ...(mode ? { mode } : {}),
        }),
      });

      const latency = Date.now() - t0;
      if (!resp.ok) {
        console.warn(`[WARN] (${idx + 1}/${scaffoldData.total_queries}) ${q.query_id} HTTP ${resp.status}`);
        failed++;
        results.push({
          query_id: q.query_id,
          query_text: q.query_text,
          bucket: q.bucket,
          split: q.split,
          doc_ids: [],
          latency_ms: latency,
          total_matches: 0,
          used_intelligence: false,
        });
        continue;
      }

      const body = await resp.json();
      const docIds: string[] = (body.results || []).map((r: any) => r.asset_id).filter(Boolean);

      results.push({
        query_id: q.query_id,
        query_text: q.query_text,
        bucket: q.bucket,
        split: q.split,
        doc_ids: docIds,
        latency_ms: latency,
        total_matches: body.total || 0,
        used_intelligence: body.search_meta?.used ?? false,
        recovery_stage: body.search_meta?.recovery_stage,
        semantic_active: body.search_meta?.semantic_active,
      });

      successful++;
      if ((idx + 1) % 25 === 0 || idx === scaffoldData.total_queries - 1) {
        console.log(`Progress: ${idx + 1}/${scaffoldData.total_queries} queries executed (${successful} ok, ${failed} err)`);
      }
    } catch (err: any) {
      const latency = Date.now() - t0;
      console.warn(`[WARN] (${idx + 1}/${targetQueries.length}) ${q.query_id} Error: ${err.message}`);
      failed++;
      results.push({
        query_id: q.query_id,
        query_text: q.query_text,
        bucket: q.bucket,
        split: q.split,
        doc_ids: [],
        latency_ms: latency,
        total_matches: 0,
        used_intelligence: false,
      });
    }
  }

  fs.writeFileSync(outPath, JSON.stringify({ results }, null, 2), 'utf-8');

  console.log('================================================================================');
  console.log('BENCHMARK RETRIEVAL COMPLETE');
  console.log(`Total:      ${targetQueries.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed:     ${failed}`);
  console.log(`Saved to:   ${outPath}`);
  console.log('================================================================================');
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
