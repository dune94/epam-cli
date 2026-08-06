/**
 * THE SEAM UNDER SLOWNESS — the case that killed a run and had no test.
 *
 * `runAgentForJson` carries retry, the model ladder, provider fallback, self-heal AND the
 * wall-clock timeout. Every existing test stubs the runner with an instant answer, so the
 * timeout path — the one that ends runs — has never been executed once.
 *
 * Live 2026-08-06, run 20260806T205058Z:
 *
 *   VC guard could not be armed for AMSD-2041: guard-vocabulary agent failed
 *   (prompt runner timed out after 360000ms). A guard with no vocabulary checks nothing.
 *   openspec returned null for AMSD-2041 (attempt 2/3) — retrying transient failure
 *
 * The story reached the writer pause with ZERO verification criteria, and the pause still
 * announced "inputs ready". Nothing was wrong with the model's answer; it never got to give
 * one.
 *
 * THREE ARCHITECTURAL FAULTS THIS PINS:
 *
 *  1. The budget is a picked number — `RUNCLAUDE_TIMEOUT_MS || '360000'` — applied uniformly
 *     regardless of prompt size, model, reasoning effort, or whether a strict response schema
 *     forces a long think before the first token. It is not derived from anything.
 *  2. A timeout is indistinguishable from a wrong answer. For an arms-or-aborts guard both
 *     mean "run dead", and the retry re-rolls identical work against an identical budget, so
 *     a systematically slow call fails three times the same way. "The model was wrong" and
 *     "we did not wait long enough" need different responses.
 *  3. Failure must remain honest: a timeout must surface as a timeout, never as an empty
 *     answer that downstream code reads as "nothing to report".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A runner that takes `delayMs` to answer — the thing no test has ever used. */
function slowRunner(delayMs: number, answer: string) {
  const dir = mkdtempSync(join(tmpdir(), 'slow-runner-')); dirs.push(dir);
  const marker = join(dir, 'started');
  const sh = join(dir, 'run.sh');
  writeFileSync(sh,
    `#!/usr/bin/env bash\n` +
    `touch ${JSON.stringify(marker)}\n` +
    `sleep ${(delayMs / 1000).toFixed(3)}\n` +
    `cat <<'ANSWER'\n${answer}\nANSWER\n`);
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], dir, marker };
}

const GOOD = '<GUARD_VOCABULARY>{"blacklist":[{"term":"x","reason":"r"}],"whitelist":[]}</GUARD_VOCABULARY>';

async function callSeam(runner: { cmd: string; args: string[] }, timeoutMs: number, logDir: string) {
  const prev = { p: process.env.SPEC_MODE_PROVIDER, t: process.env.RUNCLAUDE_TIMEOUT_MS };
  delete process.env.SPEC_MODE_PROVIDER;
  process.env.RUNCLAUDE_TIMEOUT_MS = String(timeoutMs);
  try {
    return await spec.deriveGuardVocabulary({
      promptExec: runner,
      rule: 'a rule', statements: ['a statement'],
      story: { id: 'T-1', title: 't', description: 'd' },
      findings: [], manifestFiles: [], logDir, seam: 'test',
    });
  } finally {
    if (prev.p === undefined) delete process.env.SPEC_MODE_PROVIDER; else process.env.SPEC_MODE_PROVIDER = prev.p;
    if (prev.t === undefined) delete process.env.RUNCLAUDE_TIMEOUT_MS; else process.env.RUNCLAUDE_TIMEOUT_MS = prev.t;
  }
}

describe('a runner slower than its budget', () => {
  it('the fixture is real — a fast runner through the same seam succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-ok-')); dirs.push(dir);
    const r = slowRunner(50, GOOD);
    const vocab = await callSeam(r, 10_000, dir);
    expect(vocab, 'the seam cannot answer at all — every assertion below would be meaningless').toBeTruthy();
    expect(vocab.blacklist.length).toBeGreaterThan(0);
  }, 60_000);

  it('THE FAILURE: a slow runner yields no vocabulary, so an arms-or-abort guard kills the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-slow-')); dirs.push(dir);
    const r = slowRunner(3_000, GOOD);
    // A timeout THROWS out of the seam; the caller turns that into "guard could not be armed".
    // The distinction that matters is that the failure is a TIMEOUT, not a wrong answer — the
    // model would have answered correctly given the time.
    let err: any = null;
    try { await callSeam(r, 700, dir); } catch (e) { err = e; }
    expect(r.marker && existsSync(r.marker), 'the runner never started — this is not a timeout test').toBe(true);
    expect(err, 'a runner that never answered was treated as a successful call').toBeTruthy();
    expect(
      String(err && err.message),
      'the failure does not say it was a timeout, so a slow call is indistinguishable from a wrong one',
    ).toMatch(/timed out/i);
  }, 60_000);

  it('the timeout is RECORDED as a timeout, not as an empty answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-log-')); dirs.push(dir);
    const r = slowRunner(3_000, GOOD);
    try { await callSeam(r, 700, dir); } catch { /* expected */ }
    const log = join(dir, 'T-1-guard-vocabulary.log');
    expect(existsSync(log), 'nothing was written, so a run cannot be diagnosed afterwards').toBe(true);
    expect(
      readFileSync(log, 'utf8'),
      'a timeout that reads like an empty answer sends the next person hunting the wrong bug',
    ).toMatch(/timed out/i);
  }, 60_000);
});

describe('the budget is derived and adjustable, not a fixed number', () => {
  it('RUNCLAUDE_TIMEOUT_MS actually governs the wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-budget-')); dirs.push(dir);
    const r = slowRunner(1_500, GOOD);
    const started = Date.now();
    try { await callSeam(r, 600, dir); } catch { /* expected — the budget cut it off */ }
    const elapsed = Date.now() - started;
    expect(elapsed, 'the configured budget was ignored').toBeLessThan(1_400);
  }, 60_000);

  it('a budget large enough lets the same slow call through — slowness is not wrongness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seam-wide-')); dirs.push(dir);
    const r = slowRunner(1_500, GOOD);
    const vocab = await callSeam(r, 20_000, dir);
    expect(
      vocab,
      'the identical call that "failed" at a smaller budget succeeds at a larger one — the answer was never the problem',
    ).toBeTruthy();
    expect(vocab.blacklist.length).toBeGreaterThan(0);
  }, 60_000);
});
