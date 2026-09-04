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
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
// THE FIRST CANDIDATE THAT ANSWERS, not a pinned port. This pinned :3100 — the compose default —
// so it was red on every machine whose Langfuse is anywhere else, which is every isolated install.
// Red for an environmental reason is noise that hides real failures: it sat here failing while the
// actual tracing defect (no endpoint resolved at all, so no sessions ever appeared) went unnoticed.
function backendAnswers(url: string): boolean {
  try {
    return execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '3',
      `${url}/api/public/health`], { encoding: 'utf8' }).trim().startsWith('2');
  } catch { return false; }
}
const BASE = (() => {
  const candidates: string[] = [];
  if (env.LANGFUSE_BASE_URL) candidates.push(String(env.LANGFUSE_BASE_URL).replace(/\/+$/, ''));
  try {
    const root = '/home/bradleyjerome/projects/ai';
    // Numerically: "pipeline-tests-9" sorts after "pipeline-tests-17" as a string.
    for (const d of readdirSync(root)
      .filter((x) => /^pipeline-tests-\d+$/.test(x))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))) {
      const f = join(root, d, '.pipeline-services-state.env');
      if (!existsSync(f)) continue;
      const m = readFileSync(f, 'utf8').match(/^OBS_LANGFUSE_PORT=(\d+)\s*$/m);
      if (m) candidates.push(`http://localhost:${m[1]}`);
    }
  } catch { /* fall through to the declared default */ }
  candidates.push('http://localhost:3100');
  return candidates.find(backendAnswers) ?? candidates[0];
})();
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

/**
 * THE ENDPOINT MUST RESOLVE THE WAY EVERY OTHER ENDPOINT IN THIS PIPELINE RESOLVES.
 *
 * langfuse-emit.js read LANGFUSE_BASE_URL out of the environment and, finding it empty, returned
 * null — silently, by design ("a guessed host would post this run's data somewhere unintended").
 * That is right about guessing and wrong about giving up: this install already KNOWS which port its
 * own Langfuse got, in .pipeline-services-state.env, the same file service_url() reads for the
 * dashboard and grafana.
 *
 * Live 2026-09-04: the operator saw no sessions and no traces on pipeline-tests-17 while Langfuse
 * itself was healthy on :3110 and both keys had reached the run. LANGFUSE_BASE_URL had been removed
 * from .env earlier the same day — correctly, because it was pinned to :3100, the compose default,
 * which is wrong for every isolated install — on the assumption that the state-file fallback used
 * everywhere else would cover it. This file was the one consumer that had no such fallback, so
 * removing the literal turned emission off entirely. "This was working in dev" is the tell: dev's
 * Langfuse really is on :3100.
 *
 * Precedence is unchanged where it already existed — an explicit env var still outranks the file.
 */
describe('the langfuse endpoint resolves from this install, not from a hand-set literal', () => {
  const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/langfuse-emit.js');

  /** Resolve in a child process with a controlled env and a controlled install root. */
  function resolveBase(env: Record<string, string>, stateFile: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'lf-endpoint-'));
    // A tree shaped like an install: <root>/orchestrations/scripts/lib/langfuse-emit.js
    mkdirSync(join(dir, 'orchestrations/scripts/lib'), { recursive: true });
    mkdirSync(join(dir, 'orchestrations/config'), { recursive: true });
    copyFileSync(LIB, join(dir, 'orchestrations/scripts/lib/langfuse-emit.js'));
    copyFileSync(join(REPO_ROOT, 'orchestrations/config/observability.json'),
      join(dir, 'orchestrations/config/observability.json'));
    copyFileSync(join(REPO_ROOT, 'orchestrations/config/services.json'),
      join(dir, 'orchestrations/config/services.json'));
    if (stateFile !== null) writeFileSync(join(dir, '.pipeline-services-state.env'), stateFile);
    try {
      const out = execFileSync(process.execPath, ['-e', `
        const m = require(${JSON.stringify(join(dir, 'orchestrations/scripts/lib/langfuse-emit.js'))});
        const cfg = m.config(process.env);
        process.stdout.write(cfg ? String(cfg.base) : '');
      `], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000 });
      return out.trim();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-x', LANGFUSE_SECRET_KEY: 'sk-x', LANGFUSE_BASE_URL: '' };

  it('uses THIS install\'s allocated port when no LANGFUSE_BASE_URL is set', () => {
    const base = resolveBase(KEYS, 'OBS_LANGFUSE_PORT=3110\n');
    expect(base, 'emission is silently off on every isolated install — no sessions, no traces')
      .toBe('http://localhost:3110');
  });

  it('an explicit LANGFUSE_BASE_URL still wins — precedence is unchanged', () => {
    const base = resolveBase({ ...KEYS, LANGFUSE_BASE_URL: 'http://langfuse.internal:9999' },
      'OBS_LANGFUSE_PORT=3110\n');
    expect(base).toBe('http://langfuse.internal:9999');
  });

  it('falls back to the declared default when there is no state file — the dev checkout', () => {
    const declared = JSON.parse(
      readFileSync(join(REPO_ROOT, 'orchestrations/config/services.json'), 'utf8'),
    ).services.langfuse.url;
    expect(resolveBase(KEYS, null)).toBe(String(declared).replace(/\/+$/, ''));
  });

  it('still emits nothing without keys — a half-configured backend is not a backend', () => {
    expect(resolveBase({ LANGFUSE_PUBLIC_KEY: 'pk-x', LANGFUSE_SECRET_KEY: '', LANGFUSE_BASE_URL: '' },
      'OBS_LANGFUSE_PORT=3110\n')).toBe('');
  });
});
