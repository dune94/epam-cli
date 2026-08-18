/**
 * A RUN THAT SPENT MONEY CANNOT FINISH WITH AN EMPTY COST LEDGER.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION. 2026-08-13.
 *
 * The 2026-08-13 gotransit run cost $7.47 by OpenRouter's own counter and wrote ZERO records to
 * phase-cost.jsonl. Every reader of that ledger — the dashboard, the run report, the cost-variance
 * gate — saw $0.00 and said nothing. The gate then escalated on a 597% variance computed against a
 * stale estimate, which is a confident number derived from no data at all.
 *
 * The truth was on disk the whole time: each attempt's *_result.json carries total_cost_usd and a
 * usage block, and usage-progress-<story>.json carries the running total. So this is not a
 * measurement problem. It is a REPORTING problem, and reporting zero is worse than reporting
 * nothing, because zero is a number people act on.
 *
 * Cost tracking is the operator's stated priority #1. The rule this enforces is narrow and cheap:
 * if a run made model calls, its ledger must contain records. Anything else is a defect, and it
 * must be LOUD at the end of the run rather than discovered days later in a report.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/cost-ledger.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A LOG_DIR holding whatever evidence of spend and whatever ledger the case needs. */
function check(opts: { ledgerLines?: string[]; results?: number; usage?: boolean }): { out: string; rc: number } {
  const dir = mkdtempSync(join(tmpdir(), 'cost-ledger-')); dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(join(logDir, 'claude_outputs'), { recursive: true });
  writeFileSync(join(logDir, 'phase-cost.jsonl'), (opts.ledgerLines ?? []).join('\n') + (opts.ledgerLines?.length ? '\n' : ''));
  for (let i = 0; i < (opts.results ?? 0); i++) {
    writeFileSync(join(logDir, 'claude_outputs', `S-${i}_result.json`),
      JSON.stringify({ total_cost_usd: 1.23, usage: { input_tokens: 100, output_tokens: 10 } }));
  }
  if (opts.usage) {
    writeFileSync(join(logDir, 'usage-progress-S-1.json'),
      JSON.stringify({ inputTokens: 1000, outputTokens: 100, costUsd: 1.23 }));
  }
  const script = `set -uo pipefail
LOG_DIR=${JSON.stringify(logDir)}
error() { printf 'ERROR %s\\n' "$*"; }
warning() { printf 'WARN %s\\n' "$*"; }
info() { printf '%s\\n' "$*"; }
. ${JSON.stringify(LIB)}
assert_cost_ledger_not_silently_empty || echo "LEDGER_CHECK_FAILED"`;
  try {
    return { out: execFileSync('bash', ['-c', script], { encoding: 'utf8' }), rc: 0 };
  } catch (e: any) {
    return { out: (e.stdout || '') + (e.stderr || ''), rc: e.status ?? -1 };
  }
}

const RECORD = JSON.stringify({ story_id: 'S-1', cost_usd: 1.23, phase_id: 'core' });

describe('SPEND WITH NO RECORD IS A LOUD FAILURE', () => {
  it('model calls happened and the ledger is empty — the run says so', () => {
    // THE 2026-08-13 CASE, exactly: result files on disk, ledger empty, everyone reported $0.00.
    const r = check({ ledgerLines: [], results: 3 });
    expect(r.out, 'a run that spent money reported nothing and said nothing')
      .toContain('LEDGER_CHECK_FAILED');
    expect(r.out).toMatch(/cost|ledger/i);
  });

  it('the failure names the evidence it found, so it can be acted on', () => {
    const r = check({ ledgerLines: [], results: 3 });
    expect(r.out, 'the operator is told it is broken but not what proves it')
      .toMatch(/3|result/i);
  });

  it('usage-progress alone is enough evidence of spend', () => {
    // Whichever artefact survives, the conclusion is the same: money was spent.
    expect(check({ ledgerLines: [], usage: true }).out).toContain('LEDGER_CHECK_FAILED');
  });
});

describe('A HEALTHY RUN PASSES QUIETLY', () => {
  it('records present alongside model calls is fine', () => {
    const r = check({ ledgerLines: [RECORD], results: 3 });
    expect(r.out).not.toContain('LEDGER_CHECK_FAILED');
  });

  it('a run that made NO model calls and recorded nothing is fine', () => {
    // A dry run, or a phase that skipped everything. No spend, no records, no complaint.
    const r = check({ ledgerLines: [], results: 0 });
    expect(r.out).not.toContain('LEDGER_CHECK_FAILED');
  });
});

describe('IT NEVER INVENTS A NUMBER', () => {
  it('the check reports absence — it does not reconstruct cost from the results', () => {
    // Reconstruction would paper over the defect and produce a second source of truth for money.
    const src = readFileSync(LIB, 'utf8');
    expect(src, 'the ledger check computes a cost of its own')
      .not.toMatch(/total_cost_usd\s*\+|sum|accumulat/i);
  });
});
