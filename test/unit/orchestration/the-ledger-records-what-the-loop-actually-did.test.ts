/**
 * THE LEDGER RECORDS WHAT THE LOOP ACTUALLY DID.
 *
 * The cost ledger stored one row per invocation with task_turns: 1 — for calls that read over a
 * MILLION cached tokens. A single request cannot do that, so the row was hiding an agentic loop
 * of many internal iterations behind one aggregate. Measured pipeline-tests-44: roster-specialiser
 * recorded turns=1 and cache_read=1,051,108.
 *
 * The data was never missing. The Claude CLI reply already carries it:
 *
 *   usage.iterations[]                          one entry per internal iteration, with its own
 *                                               input/output/cache figures
 *   usage.cache_creation.ephemeral_1h_input_tokens   billed at input x2.0
 *   usage.cache_creation.ephemeral_5m_input_tokens   billed at input x1.25
 *   modelUsage{}                                per-model costUSD and thinkingTokens
 *   stop_reason                                 whether the answer was truncated
 *
 * WHY IT MATTERS BEYOND CURIOSITY. Anthropic's method for sizing any budget or choosing any model
 * is "sum usage.output_tokens across every request in the loop ... start with the p99" and
 * "compare models on cost per completed task". Both need per-iteration figures. Without them the
 * ladder's iteration budgets (40 at medium/high, 250 at highest) are unfalsifiable: nobody can
 * tell a cheap rung that ran out of room from one that was not capable. Every tier decision,
 * including two I attempted and reverted on 2026-09-08, is made blind until this is recorded.
 *
 * And the 1h/5m split is not a detail: cache writes are the dearest token class, and this run
 * wrote 2,956,614 of them. At x2.0 versus x1.25 that is a materially different bill, and the
 * ledger could not tell which it paid.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/cost-record.sh');
const FIXTURE = join(ROOT, 'test/fixtures/cost/claude-cli-reply.json');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Drives the real recorder over a REAL captured CLI reply and returns the ledger row. */
function record(replyMutator?: (j: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-')); dirs.push(dir);
  const reply = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (replyMutator) replyMutator(reply);
  const replyFile = join(dir, 'reply.json');
  writeFileSync(replyFile, JSON.stringify(reply));
  const logDir = join(dir, 'logs'); mkdirSync(logDir, { recursive: true });

  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; LOG_DIR=${JSON.stringify(logDir)} `
    + `record_call_cost ${JSON.stringify(replyFile)} seam-under-test story-1 claude-haiku-4-5 2>/dev/null || true`],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOG_DIR: logDir } });

  const f = join(logDir, 'phase-cost.jsonl');
  if (!existsSync(f)) return { row: null, err: r.stderr };
  const lines = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return { row: lines.length ? JSON.parse(lines[lines.length - 1]) : null, err: r.stderr };
}

describe('the ledger records what the loop actually did', () => {
  it('GUARD: the fixture is a real CLI reply carrying the fields at issue', () => {
    const j = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(Array.isArray(j.usage.iterations), 'fixture has no usage.iterations').toBe(true);
    expect(j.usage.cache_creation).toBeTruthy();
  });

  it('GUARD: the recorder writes a row at all', () => {
    const { row, err } = record();
    expect(row, `no ledger row written: ${err}`).toBeTruthy();
  });

  it('RECORDS HOW MANY ITERATIONS THE LOOP RAN — not just that it was one invocation', () => {
    const { row } = record();
    expect(row.task_iterations,
      'the ledger does not record usage.iterations.length, so an agentic loop of many internal '
      + 'iterations is indistinguishable from a single request — which is why turns read 1 on a '
      + 'call that consumed 1,051,108 cached tokens').toBe(1);
  });

  it('RECORDS THE ITERATION COUNT OF A MULTI-ITERATION LOOP', () => {
    const { row } = record((j) => {
      const one = j.usage.iterations[0];
      j.usage.iterations = [one, { ...one }, { ...one }, { ...one }];
    });
    expect(row.task_iterations, 'a four-iteration loop is still recorded as one').toBe(4);
  });

  it('SPLITS CACHE WRITES BY TTL — 1h bills at x2.0, 5m at x1.25', () => {
    const { row } = record();
    expect(row.cache_create_1h_tokens,
      'the ledger cannot tell a 2.0x cache write from a 1.25x one, and this run wrote 2.96M of them')
      .toBe(9325);
    expect(row.cache_create_5m_tokens).toBe(0);
  });

  it('RECORDS WHY THE ANSWER STOPPED — truncation must not look like completion', () => {
    const { row } = record();
    expect(row.stop_reason,
      'a response cut off at max_tokens is indistinguishable from one that finished').toBeTruthy();
  });

  it('KEEPS THE FIGURES IT ALREADY RECORDED — nothing regresses', () => {
    const { row } = record();
    expect(row.cache_read_tokens).toBe(10010);
    expect(row.task_tokens_out).toBe(4);
    expect(row.task_turns).toBe(1);
  });
});
