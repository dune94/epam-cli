/**
 * 62% OF THIS ENGINE IS SHELL, AND NOTHING MEASURED IT.
 *
 * 28,530 of 46,079 engine code lines are bash. Every coverage figure this project has ever reported
 * covered the other 38% — and the discovery gate that reads "95%" measures 436 lines, which is 0.9%
 * of the engine. So for the larger half of the pipeline the question "what have we never run" could
 * not be asked at all.
 *
 * That is not an abstraction. project-roster.js shipped a seam check at v1.5 that NO test ever
 * exercised — the only test touching checkEntry passed no seam value — and on 2026-08-31 it killed
 * a live metrolinx run. Nothing could have told us, because nothing was counting.
 *
 * kcov, bashcov and shellspec are all absent and cannot be installed here. bash can answer for
 * itself: PS4 carrying ${BASH_SOURCE}:${LINENO}, xtrace on its own descriptor. This asserts the
 * instrument WORKS and gates one real file with it, so the mechanism is load-bearing rather than
 * demonstrative.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { traceRun, coverageOf, codeLines } = require(join(REPO, 'test/helpers/bash-line-coverage.js'));

const GATE_VERDICTS = 'orchestrations/scripts/lib/gate-verdicts.sh';

/** Drive every branch of qa_gate_verdict_of, the reader a gate's outcome depends on. */
function driveVerdictReader() {
  const work = mkdtempSync(join(tmpdir(), 'shellcov-'));
  const cases: Record<string, string> = {
    fail: '{"verdict": "fail"}',
    warn: '{"verdict": "warn"}',
    pass: '{"verdict": "pass"}',
    prose: 'the browser could not start',
    empty: '',
  };
  const lines: string[] = [`. ${JSON.stringify(join(REPO, GATE_VERDICTS))}`];
  for (const [name, body] of Object.entries(cases)) {
    const f = join(work, `${name}.log`);
    writeFileSync(f, body);
    lines.push(`qa_gate_verdict_of ${JSON.stringify(f)}`);
  }
  lines.push('qa_gate_verdict_of /nonexistent/log');
  lines.push('qa_gate_verdict_of ""');
  return traceRun(lines.join('\n'), { cwd: REPO });
}

describe('shell coverage is measured at all', () => {
  it('the instrument reports lines from a REAL file, not a copy', () => {
    // Without this the numbers below could come from a temp script and mean nothing.
    const r = driveVerdictReader();
    const seen = [...r.hits.keys()].map((f: string) => String(f));
    expect(seen.some((f) => f.endsWith('gate-verdicts.sh')),
      `the trace saw no lines of the real file; it saw: ${seen.join(', ') || '(nothing)'}`).toBe(true);
  }, 120_000);

  it('and it distinguishes executed lines from unexecuted ones', () => {
    // A "coverage" tool that reports everything covered, or nothing, is worse than none.
    const r = driveVerdictReader();
    const rep = coverageOf([join(REPO, GATE_VERDICTS)], r.hits);
    const v = Object.values<any>(rep)[0];
    expect(v.total, 'no code lines were counted').toBeGreaterThan(50);
    expect(v.covered, 'nothing was reported as covered').toBeGreaterThan(0);
    expect(v.uncovered.length, 'EVERYTHING was reported as covered, which is not credible for a '
      + 'file holding a retry loop this test never drives').toBeGreaterThan(0);
  }, 120_000);

  it('the verdict reader every QA gate depends on is fully driven', () => {
    // The gate. qa_gate_verdict_of decides whether a gate passed; a line of it that no test runs is
    // a decision nobody has checked. Scoped to that function, because the retry loop beside it
    // needs a live runner and is honestly out of reach here.
    const r = driveVerdictReader();
    const src = require('node:fs').readFileSync(join(REPO, GATE_VERDICTS), 'utf8').split('\n');
    const first = src.findIndex((l: string) => l.startsWith('qa_gate_verdict_of() {'));
    expect(first, 'qa_gate_verdict_of is gone').toBeGreaterThan(-1);
    const last = src.findIndex((l: string, i: number) => i > first && l === '}');

    // ABSOLUTE line numbers, taken straight from the file. Deriving them by arithmetic on a slice
    // is how the first version demanded coverage of a comment and the function's own declaration —
    // two lines that can never appear in a trace.
    const wanted: number[] = [];
    src.forEach((line: string, i: number) => {
      if (i <= first || i > last) return;
      if (codeLines(line).size) wanted.push(i + 1);
    });
    const ran = [...(r.hits.get(join(REPO, GATE_VERDICTS)) || new Set())] as number[];
    const missed = wanted.filter((n) => !ran.includes(n));
    expect(missed, `these lines of qa_gate_verdict_of were never executed: ${missed.join(', ')}`)
      .toEqual([]);
  }, 120_000);
});
