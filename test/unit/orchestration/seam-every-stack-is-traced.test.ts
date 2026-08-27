/**
 * A TRACE THAT REACHES LANGFUSE, OR THIS TEST FAILS.
 *
 * Tracing lived in src/observability/TracedProvider.ts, a decorator around the TypeScript
 * LLMProvider — reachable ONLY through the hub's `epam` arm. Any stack that executes a vendor
 * binary directly (which is how a subscription pays instead of an API key) emitted nothing.
 * Measured 2026-08-27: Langfuse held 84,145 traces and ZERO from that day's three runs, because
 * observability was a property of one vendor path rather than of the pipeline.
 *
 * WHY THIS TEST IS AN INTEGRATION TEST AND NOT A MOCK. Every test I wrote today passed while the
 * thing it described stayed broken, because it asserted a mechanism against a fixture I authored.
 * A mocked fetch here would prove the emitter builds a payload I invented — the same mistake. So
 * this POSTs to the real Langfuse and then reads the trace back out of it. The artifact is the
 * assertion.
 *
 * It spends no model tokens: Langfuse is local HTTP.
 *
 * IT MUST NOT PASS VACUOUSLY. If Langfuse is unreachable or the keys are absent, that is a FAILED
 * test, never a skipped one — "the backend was down" is exactly the state that let three runs go
 * untraced without anyone noticing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emitGeneration } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/langfuse-emit.js'));

/**
 * Keys read from .env WITHOUT executing it. The repo's .env begins with a bare `cd`, so sourcing
 * it moves the shell — a defect this codebase already carries a safe loader for. Parsed here for
 * the same reason.
 */
function envFromDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = '';
  try { raw = readFileSync(join(REPO_ROOT, '.env'), 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const dotenv = envFromDotEnv();
const BASE = (dotenv.LANGFUSE_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '');
const AUTH = 'Basic ' + Buffer.from(
  `${dotenv.LANGFUSE_PUBLIC_KEY || ''}:${dotenv.LANGFUSE_SECRET_KEY || ''}`,
).toString('base64');

// A run id unique to this test execution, so the trace read back can only be the one just written.
const RUN_ID = `test-${process.pid}-${Date.now()}`;
const AGENT = 'seam-trace-probe';
const MODEL = 'model-under-test';

async function fetchTrace(id: string): Promise<any | null> {
  // Ingestion is asynchronous; poll rather than assume it has landed.
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/public/traces?limit=50&sessionId=${encodeURIComponent(RUN_ID)}`,
        { headers: { authorization: AUTH } });
      if (r.ok) {
        const d: any = await r.json();
        const hit = (d.data || []).find((t: any) => t.id === id || t.sessionId === RUN_ID);
        if (hit) return hit;
      }
    } catch { /* keep polling */ }
    await new Promise((res) => setTimeout(res, 500));
  }
  return null;
}

let reachable = false;
beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/api/public/health`, { headers: { authorization: AUTH } });
    reachable = r.ok || r.status === 401 || r.status === 404;
  } catch { reachable = false; }
});

describe('every stack is traced, not just the one with a provider decorator', () => {
  it('Langfuse is reachable and configured — a down backend is a FAILURE, never a skip', () => {
    expect(dotenv.LANGFUSE_PUBLIC_KEY, 'LANGFUSE_PUBLIC_KEY absent from .env').toBeTruthy();
    expect(dotenv.LANGFUSE_SECRET_KEY, 'LANGFUSE_SECRET_KEY absent from .env').toBeTruthy();
    expect(reachable, `Langfuse not reachable at ${BASE} — runs would go untraced silently`).toBe(true);
  });

  it('emits a generation that ARRIVES — read back out of Langfuse, not asserted on the payload', async () => {
    const started = new Date(Date.now() - 1500).toISOString();
    const ended = new Date().toISOString();
    const ok = await emitGeneration({
      agent: AGENT, storyId: 'STORY-1', phase: 'core', provider: 'any-stack',
      model: MODEL, tokensIn: 11, tokensOut: 22, costUsd: 0.0123,
      cacheRead: 333, cacheCreate: 44, turns: 2, rung: 1,
      startedAt: started, endedAt: ended,
    }, { ...process.env, ...dotenv, EPAM_RUN_ID: RUN_ID });

    expect(ok, 'the emitter reported the ingestion was refused').toBe(true);

    const trace = await fetchTrace('');
    expect(trace, `no trace with sessionId ${RUN_ID} ever appeared in Langfuse`).toBeTruthy();
    // THE SESSION IS THE RUN. Every historical trace carried sessionId null, so nothing could be
    // grouped into "the run that happened at 10:05" — the question an operator actually asks.
    expect(trace.sessionId).toBe(RUN_ID);
    expect(trace.name).toBe(AGENT);
  });

  it('is disabled, not broken, when the backend is not configured', async () => {
    // A project with no Langfuse must run exactly as before — observability is additive.
    const ok = await emitGeneration({ agent: 'x', model: 'y' },
      { LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '' });
    expect(ok).toBe(false);
  });

  it('never throws, whatever the backend does — it must not break the call it observes', async () => {
    await expect(emitGeneration({ agent: 'x', model: 'y' }, {
      ...dotenv, LANGFUSE_BASE_URL: 'http://127.0.0.1:1', LANGFUSE_TIMEOUT_MS: '300',
    })).resolves.toBe(false);
  });
});
