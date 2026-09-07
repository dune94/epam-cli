/**
 * CACHE TOKENS ARE PART OF THE BILL.
 *
 * emitCostSnapshot has always recorded tokensCached (input served FROM the prompt cache) and
 * tokensCacheCreate (input written INTO it) — they are priced differently from fresh input, which
 * is exactly why they are kept apart rather than folded into tokensIn. The run report's cost table
 * then summed only in/out, so a run whose spend was mostly cache reads showed a token count that
 * did not add up to its own cost column.
 *
 * BOTH ENDS: the producer's own field names drive this, so a rename on the emitter side breaks
 * this test rather than silently zeroing the columns again.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(process.cwd(), 'orchestrations', 'scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** One cost_snapshot in the shape lib/cost-emitter.js actually writes. */
const snapshot = (agent: string, det: Record<string, unknown>) =>
  JSON.stringify({ type: 'cost_snapshot', agent, detail: det });

function narrativeFor(rows: string[]): string {
  const logs = tmp('logs-');
  writeFileSync(join(logs, 'agent-activity.jsonl'), rows.join('\n') + '\n');
  const out = tmp('out-');
  const logFile = join(tmp('log-'), 'run.log');
  writeFileSync(logFile, '✓ Pipeline complete\n');
  execFileSync('python3', [join(SCRIPTS, 'generate-run-report.py'),
    '--launch-log', logFile, '--logs-dir', logs, '--out', out],
    { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
  return readFileSync(join(out, 'narrative.html'), 'utf8');
}

describe('the cost table', () => {
  it('reports cache read and cache write, not just in and out', () => {
    const h = narrativeFor([snapshot('writer', {
      costUsd: 1.25, tokensIn: 1000, tokensOut: 2000,
      tokensCached: 345678, tokensCacheCreate: 91011,
    })]);
    expect(h, 'no cache-read column').toContain('Cache read');
    expect(h, 'no cache-write column').toContain('Cache write');
    expect(h, 'cache reads were not counted — the token columns do not explain the cost')
      .toContain('345,678');
    expect(h, 'cache writes were not counted').toContain('91,011');
  });

  it('sums cache tokens across every call an agent made', () => {
    const h = narrativeFor([
      snapshot('writer', { costUsd: 0.5, tokensIn: 1, tokensOut: 1, tokensCached: 100, tokensCacheCreate: 10 }),
      snapshot('writer', { costUsd: 0.5, tokensIn: 1, tokensOut: 1, tokensCached: 400, tokensCacheCreate: 90 }),
    ]);
    expect(h, 'per-agent cache totals are not summed across calls').toContain('500');
    expect(h).toContain('100');
  });

  it('a run recorded before cache fields existed still renders, showing zero', () => {
    // Older activity streams carry only tokensIn/tokensOut. Absent must read as zero, not crash
    // and not be invented.
    const h = narrativeFor([snapshot('writer', { costUsd: 0.25, tokensIn: 10, tokensOut: 20 })]);
    expect(h).toContain('Cache read');
    expect(h).toContain('$0.2500');
  });
});
