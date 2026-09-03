/**
 * TEST THE FUNCTION THE PIPELINE CALLS, NOT THE ONE I JUST WROTE.
 *
 * Live 2026-08-27, run 20260827T125654Z: Langfuse received ZERO traces while the run executed
 * normally. The emitter was fine — a direct test of emitGeneration passed, and still does. The
 * pipeline does not call emitGeneration. It calls emitCostSnapshot, which calls emitGeneration,
 * and the bug lived in that join:
 *
 *     ReferenceError: endedAt is not defined
 *
 * emitCostSnapshot destructures `startedAt, rung` and NOT `endedAt`, and the hook referenced it.
 * Every emit threw before reaching the network. The cost record was still written and returned, so
 * nothing looked wrong anywhere.
 *
 * TWO OF MY OWN MISTAKES MADE IT INVISIBLE:
 *   1. The test targeted the leaf I had written instead of the entry point the pipeline invokes.
 *   2. The hook was wrapped in `try {} catch {}` with the reasoning "observability must never break
 *      the call" — correct as a goal, and implemented as a total swallow, so a permanently broken
 *      emitter was indistinguishable from one that was simply not configured. Absence is not a
 *      signal.
 *
 * So this test enters at emitCostSnapshot, with a result file shaped like the one the hub really
 * writes, and asserts the TRACE ARRIVES — read back out of Langfuse. A ReferenceError anywhere on
 * that path fails it, which is the whole point: no assertion here needed to exist for the original
 * bug to be caught, only the call.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emitCostSnapshot } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/cost-emitter.js'));

/** Keys parsed, never sourced — the repo .env opens with a bare `cd`. */
function dotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = '';
  try { raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = dotEnv();
const BASE = (env.LANGFUSE_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '');
const AUTH = 'Basic ' + Buffer.from(
  `${env.LANGFUSE_PUBLIC_KEY || ''}:${env.LANGFUSE_SECRET_KEY || ''}`).toString('base64');

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cost-seam-')); });

/** The result file the hub writes to ORCH_JSON_RESULT, in the shape it really writes it. */
function realResultFile(): string {
  const f = join(dir, 'result.json');
  writeFileSync(f, JSON.stringify({
    total_cost_usd: 0.0234,
    usage: { input_tokens: 41, output_tokens: 77, cache_read_input_tokens: 900 },
    num_turns: 2,
  }));
  return f;
}

async function traceCount(session: string): Promise<number> {
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/public/traces?limit=20&sessionId=${encodeURIComponent(session)}`,
        { headers: { authorization: AUTH } });
      if (r.ok) { const d: any = await r.json(); if ((d.data || []).length) return d.data.length; }
    } catch { /* keep polling */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return 0;
}

describe('the cost seam emits a trace for the call it records', () => {
  it('REPRODUCES the silent loss: entering at emitCostSnapshot puts a trace in Langfuse', async () => {
    const session = `costseam-${process.pid}-${Date.now()}`;
    const prev = process.env.EPAM_RUN_ID;
    process.env.EPAM_RUN_ID = session;
    Object.assign(process.env, {
      LANGFUSE_PUBLIC_KEY: env.LANGFUSE_PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: env.LANGFUSE_SECRET_KEY,
      LANGFUSE_BASE_URL: BASE,
    });
    try {
      const rec = emitCostSnapshot({
        resultFile: realResultFile(),
        activityFile: join(dir, 'activity.jsonl'),
        ledgerFile: join(dir, 'ledger.jsonl'),
        agent: 'cost-seam-test', storyId: 'S1', phase: 'core',
        model: 'probe-model', provider: 'claude', turns: 2,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        rung: 1,
        logDir: dir,
      });
      // Guards a vacuous pass: if the snapshot bailed early the trace assertion would be
      // asserting nothing at all.
      expect(rec, 'emitCostSnapshot bailed before it could emit — the fixture is wrong').toBeTruthy();
      expect(await traceCount(session),
        'the cost seam recorded the call and emitted NO trace — the hook threw and was swallowed')
        .toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.EPAM_RUN_ID; else process.env.EPAM_RUN_ID = prev;
    }
  });

  it('still writes its ledger row when the trace backend is unreachable', async () => {
    // Observability must never break the call it observes — the goal the swallow was reaching for,
    // asserted rather than assumed.
    const prevBase = process.env.LANGFUSE_BASE_URL;
    process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1';
    try {
      const rec = emitCostSnapshot({
        resultFile: realResultFile(),
        activityFile: join(dir, 'activity2.jsonl'),
        ledgerFile: join(dir, 'ledger2.jsonl'),
        agent: 'cost-seam-offline', storyId: 'S1', phase: 'core',
        model: 'probe-model', provider: 'claude', turns: 1,
        startedAt: new Date().toISOString(), rung: 0, logDir: dir,
      });
      expect(rec, 'a dead trace backend must not stop the cost record').toBeTruthy();
    } finally {
      if (prevBase === undefined) delete process.env.LANGFUSE_BASE_URL;
      else process.env.LANGFUSE_BASE_URL = prevBase;
    }
  });
});
