/**
 * AN ATTEMPT THAT PRODUCED NOTHING WAS BILLED THE PREVIOUS ATTEMPT'S TOKENS.
 *
 * append_cost_record reads usage out of $json_result_file. When an attempt fails before writing
 * one, that file still holds the LAST attempt's result — so the ledger records the same numbers
 * again, for a call that never happened.
 *
 * Live 2026-08-18, MOCK3-1. Attempts 1 and 2 were real:
 *
 *   attempt 1  in=27614  out=2692  elapsed=.30min
 *   attempt 2  in=15812  out=1860  elapsed=.35min
 *
 * Attempts 3-12 asked a provider for a model it does not serve and returned 0 bytes in about a
 * second — and every one of them recorded:
 *
 *   attempt N  in=15812  out=1860  cost=$0.007  elapsed=.01min
 *
 * Ten fabricated charges, byte-identical to attempt 2, on the measurement the operator ranks
 * first and the story budget guard sums to enforce a limit. The giveaway was there in the log —
 * identical input tokens against a prompt that grew from 19198 to 26403 characters — but the
 * ledger cannot show that, and the dashboard reads the ledger.
 *
 * The attempt's own start time is already passed in. A result file older than the attempt did
 * not come from it, and its numbers are not this attempt's to report.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

function extractFn(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const m = src.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`claude.sh has no function ${name}()`);
  return m[0];
}

/** true/false from the shell helper, as a string. */
function isFromThisAttempt(file: string, startedAt: string) {
  const fn = extractFn('result_is_from_this_attempt');
  const r = spawnSync('bash', ['-c',
    `${fn}\nif result_is_from_this_attempt "${file}" "${startedAt}"; then echo YES; else echo NO; fi`,
  ], { encoding: 'utf8' });
  return `${r.stdout}`.trim();
}

describe('a failed attempt billed the previous ones tokens', () => {
  it('A RESULT WRITTEN DURING THE ATTEMPT IS THIS ATTEMPT\'S — the real signal survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-stale-'));
    const f = join(dir, 'result.json');
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(f, '{"usage":{"input_tokens":100}}');           // written just now, after start
    expect(isFromThisAttempt(f, startedAt)).toBe('YES');
    rmSync(dir, { recursive: true, force: true });
  });

  it('A RESULT OLDER THAN THE ATTEMPT IS THE PREVIOUS ONE\'S — the live shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-stale-'));
    const f = join(dir, 'result.json');
    writeFileSync(f, '{"usage":{"input_tokens":15812}}');
    const old = new Date(Date.now() - 600_000);
    utimesSync(f, old, old);                                      // written ten minutes ago
    const startedAt = new Date(Date.now() - 5_000).toISOString(); // this attempt started 5s ago
    expect(isFromThisAttempt(f, startedAt),
      "last attempt's usage is being reported as this attempt's").toBe('NO');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a file that does not exist is not this attempt\'s result either', () => {
    expect(isFromThisAttempt(join(tmpdir(), 'no-such-result-98765.json'),
      new Date().toISOString())).toBe('NO');
  });

  it('an empty path is not this attempt\'s result', () => {
    expect(isFromThisAttempt('', new Date().toISOString())).toBe('NO');
  });

  it('with no start time it does not guess — it declines to claim the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-stale-'));
    const f = join(dir, 'result.json');
    writeFileSync(f, '{}');
    expect(isFromThisAttempt(f, '')).toBe('NO');
    rmSync(dir, { recursive: true, force: true });
  });

  it('AND THE LEDGER CONSULTS IT — not just a helper nobody calls', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const fnStart = src.indexOf('append_cost_record() {');
    const fnEnd = src.indexOf('\n}', src.indexOf('cost_snapshot', fnStart));
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 8000);
    expect(body, 'append_cost_record still reads usage without checking whose result it is')
      .toMatch(/result_is_from_this_attempt/);
  });
});
