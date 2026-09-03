/**
 * RETEST OF 23f3050 — the regression guard now names WHY it could not run.
 *
 * Before it, the guard reported "declares a test script but it could not be run" and named no
 * cause, so diagnosing it meant re-deriving four values by hand from outside the run. The commit's
 * own words: naming the failure turned an afternoon of bisecting into one line.
 *
 * This is the same class as the halt message that reported "0 of 12 attempts used" as fact, and as
 * a gate log that could not be read being treated as a pass. A guard that declines without a
 * reason sends the operator somewhere else.
 *
 * The property: every path that sets the guard not-ready also sets a distinct reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

/** Every line that marks the guard unable to run. */
const notReadyLines = SRC.split('\n')
  .map((l, i) => ({ line: i + 1, text: l }))
  .filter(({ text }) => /_rg_ready=0/.test(text));

describe('a guard that cannot run says why', () => {
  it('there are not-ready paths to check — otherwise this proves nothing', () => {
    expect(notReadyLines.length, 'the regression guard has no not-ready path at all')
      .toBeGreaterThan(1);
  });

  it('every path that declines also sets a reason', () => {
    // A path that sets _rg_ready=0 without _rg_notready leaves the operator with the old,
    // causeless message.
    const silent = notReadyLines.filter(({ text }) => !/_rg_notready=/.test(text));
    expect(silent.map((s) => `line ${s.line}: ${s.text.trim()}`),
      'these decline without naming a cause').toEqual([]);
  });

  it('the reasons are distinct, so the message identifies WHICH check failed', () => {
    // Three paths sharing one string would be no better than the original: the operator still
    // cannot tell node-missing from dependencies-not-installed from no-test-command.
    const reasons = notReadyLines
      .map(({ text }) => /_rg_notready="([^"]+)"/.exec(text)?.[1])
      .filter(Boolean) as string[];
    expect(reasons.length, 'no reasons were parsed; the shape has changed').toBeGreaterThan(1);
    expect(new Set(reasons).size, `the reasons are not distinct: ${reasons.join(' | ')}`)
      .toBe(reasons.length);
  });

  it('and each reason says something specific, not just "failed"', () => {
    const reasons = notReadyLines
      .map(({ text }) => /_rg_notready="([^"]+)"/.exec(text)?.[1])
      .filter(Boolean) as string[];
    for (const r of reasons) {
      expect(r.length, `"${r}" is too short to point anywhere`).toBeGreaterThan(12);
      expect(r, `"${r}" names no subject`).toMatch(/node|test|depend|executable|command|codeline/i);
    }
  });
});
