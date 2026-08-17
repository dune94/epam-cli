/**
 * THE LEDGER RECORDS elapsed_minutes: 0 FOR EVERY JS-SIDE AGENT, AND DISCARDS THE $0 IT CANNOT
 * EXPLAIN.
 *
 * TWO DEFECTS IN THE THING BUILT TO ANSWER "WHAT DID THIS COST AND HOW LONG DID IT TAKE".
 *
 * 1. appendLedgerRecord accepts startedAt and NO CALLER PASSES IT, so `started` and `ended` both
 *    default to now and elapsed is always 0. Live 2026-08-17: prompt-builder, estate-survey,
 *    agent-mint, codeline-discovery, roster-review and role-assigner all recorded 0s across every
 *    run of the day, while the bash-side writer agents recorded real spreads (typescript-engineer
 *    med 83s / p90 414s / max 1976s; test-engineer med 153s / p90 1334s / max 2074s).
 *
 *    That is not cosmetic. A seam's timeoutSecs can only be set from measured duration, and
 *    prompt-builder was cut off at 360s with nobody able to say what it actually needed. A run
 *    paused 234s on one prompt and the only honest answer to "why" was that we cannot see it.
 *
 * 2. A $0 cost alongside real tokens is flagged costUnknown and then the evidence is thrown away —
 *    the result file is unlinked immediately after emission. Live 2026-08-17: ten records, 158,515
 *    input tokens, $0.0000 total, and three separate attempts to explain it were blind because
 *    nothing kept the record that produced it. Same evidence-destroying shape as the vocabulary
 *    agent throwing away the answer it could not parse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { emitCostSnapshot, appendLedgerRecord } = require(join(ROOT, 'orchestrations/scripts/lib/cost-emitter.js'));

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'ledger-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const cost = (over: Record<string, unknown> = {}) => ({
  costUsd: 0.5, tokensIn: 1000, tokensOut: 100, tokensCached: 0,
  costUnknown: false, costIsEstimate: false, ...over,
});

describe('the ledger cannot say how long anything took', () => {
  it('RECORDS A REAL DURATION when the caller says when it started', () => {
    const led = join(work, 'p.jsonl');
    const started = new Date(Date.now() - 234_000).toISOString();   // the live 234s pause
    appendLedgerRecord({ ledgerFile: led, agent: 'prompt-builder', cost: cost(), startedAt: started });
    const r = JSON.parse(readFileSync(led, 'utf8').trim());
    expect(r.elapsed_minutes, 'the ledger still says every call took no time at all')
      .toBeGreaterThan(3.5);
    expect(r.elapsed_minutes).toBeLessThan(4.5);
  });

  it('THE EMITTER PASSES IT THROUGH — the caller-to-ledger join is where it was lost', () => {
    const res = join(work, 'r.json');
    const led = join(work, 'p.jsonl');
    writeFileSync(res, JSON.stringify({ usage: { inputTokens: 10, outputTokens: 2 }, cost_usd: 0.1 }));
    emitCostSnapshot({
      resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: led,
      agent: 'x', startedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const r = JSON.parse(readFileSync(led, 'utf8').trim());
    expect(r.elapsed_minutes, 'emitCostSnapshot dropped startedAt on the way to the ledger')
      .toBeGreaterThan(1.5);
  });

  it('a caller that says nothing still records, rather than failing', () => {
    const led = join(work, 'p.jsonl');
    appendLedgerRecord({ ledgerFile: led, agent: 'x', cost: cost() });
    expect(JSON.parse(readFileSync(led, 'utf8').trim()).elapsed_minutes).toBe(0);
  });

  it('THE UNEXPLAINED $0 IS KEPT, not discarded', () => {
    // Ten records, 158,515 tokens, $0.0000 — and every attempt to explain it was blind because
    // the result file is unlinked the moment it is read.
    const res = join(work, 'r.json');
    const logDir = work;
    const payload = { usage: { inputTokens: 19785, outputTokens: 1200 }, cost_usd: 0, cost_is_estimate: false };
    writeFileSync(res, JSON.stringify(payload));

    emitCostSnapshot({
      resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: join(work, 'p.jsonl'),
      agent: 'codeline-discovery', model: 'z-ai/glm-5.2', logDir,
    });

    const kept = readdirSync(logDir).filter((f) => /cost-anomaly/.test(f));
    expect(kept.length, 'the record that produced an unexplained $0 was thrown away').toBeGreaterThan(0);
    const dump = readFileSync(join(logDir, kept[0]), 'utf8');
    expect(dump, 'the dump does not contain what the provider actually returned').toMatch(/19785/);
    expect(dump, 'the dump does not name the agent').toMatch(/codeline-discovery/);
  });

  it('a NORMAL record writes no anomaly file — this must not spam the log dir', () => {
    const res = join(work, 'r.json');
    writeFileSync(res, JSON.stringify({ usage: { inputTokens: 100, outputTokens: 10 }, cost_usd: 0.02 }));
    emitCostSnapshot({
      resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: join(work, 'p.jsonl'),
      agent: 'x', logDir: work,
    });
    expect(readdirSync(work).filter((f) => /cost-anomaly/.test(f)).length,
      'a healthy call wrote an anomaly dump').toBe(0);
  });

  it('a genuinely free call is not an anomaly either', () => {
    // Zero cost AND zero tokens is a real free call, not a reporting failure.
    const res = join(work, 'r.json');
    writeFileSync(res, JSON.stringify({ usage: { inputTokens: 0, outputTokens: 0 }, cost_usd: 0 }));
    emitCostSnapshot({
      resultFile: res, activityFile: join(work, 'a.jsonl'), ledgerFile: join(work, 'p.jsonl'),
      agent: 'x', logDir: work,
    });
    expect(readdirSync(work).filter((f) => /cost-anomaly/.test(f)).length).toBe(0);
  });
});
