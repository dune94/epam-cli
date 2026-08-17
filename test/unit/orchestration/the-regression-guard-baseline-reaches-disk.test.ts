/**
 * STEP 5 IS WHERE "WE INHERIT EXISTING TEST FAILURES BUT CANNOT BE EXPECTED TO FIX THEM" IS
 * ACTUALLY IMPLEMENTED.
 *
 * It re-runs the suite, and when the SAME failures survive every attempt it records them as a
 * tolerated baseline and lets the phase proceed. Step 3.58 later compares the after-set against
 * that file. So the baseline file is the whole mechanism: without it, either every inherited
 * failure is reported as newly introduced by the phase, or the delta gate cannot verify at all.
 *
 * The write was unchecked, and _rg_rc=0 was set regardless. A failed write left Step 5 PASSING,
 * with pre-existing failures "tolerated" and no record anywhere of what had been tolerated.
 *
 * The other half is the diagnosis. Tolerating requires the project to declare testFailurePattern.
 * Without it, a codeline carrying inherited failures hard-fails here on every run — and the
 * message told the operator to "fix failing tests from the previous phase", which is precisely
 * what the policy says they should not have to do, with no hint that the mechanism exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const INTERSECT = join(SCRIPTS, 'lib/handlers/rg-intersect.py');
const JSON_BOOL = join(SCRIPTS, 'lib/handlers/json-bool.py');

const src = () => readFileSync(ORCH, 'utf8');
const code = () => src().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rg-guard-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const PATTERN = '^FAIL\\s+(\\S+)';

/** Run the intersection over N attempt logs, as Step 5 does. */
function intersect(attempts: (string | null)[]): { stable: boolean; failures: string[] } {
  const base = join(work, 'rg.log');
  attempts.forEach((text, i) => {
    if (text === null) return;
    writeFileSync(i === 0 ? base : join(work, `rg-attempt-${i + 1}.log`), text);
  });
  const r = spawnSync('python3', [INTERSECT, PATTERN, String(attempts.length), base], { encoding: 'utf8' });
  expect(r.status, `rg-intersect crashed: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

function jsonBool(input: string, field: string): number {
  return spawnSync('python3', [JSON_BOOL, field], { input, encoding: 'utf8' }).status ?? -1;
}

describe('the regression guard baseline reaches disk', () => {
  it('the guard is not turned green unless the baseline was written', () => {
    const body = code();
    const i = body.indexOf('_rg_baseline_file"');
    expect(i, 'the baseline write is gone').toBeGreaterThan(-1);
    const block = body.slice(i - 400, i + 700);
    expect(block, 'the write is still unchecked').toMatch(/if printf .*> "\$_rg_baseline_file"; then/);
    expect(block, 'a failed write produces no message').toMatch(/could not write the tolerated baseline/);
  });

  it('a stable failure set across every attempt becomes a baseline', () => {
    const red = 'FAIL src/a.spec.ts\n';
    const r = intersect([red, red, red]);
    expect(r.stable, 'a reproducible pre-existing failure was not tolerated').toBe(true);
    expect(r.failures).toEqual(['src/a.spec.ts']);
  });

  it('a flaky failure is NOT recorded as a tolerated baseline', () => {
    // Tolerating a flake would hide a real regression in the same test for the rest of the run.
    const r = intersect(['FAIL src/a.spec.ts\n', 'FAIL src/b.spec.ts\n']);
    expect(r.stable, 'a failure that moved between attempts was tolerated').toBe(false);
  });

  it('a missing attempt log makes the set unstable, never an empty tolerated baseline', () => {
    // The sibling handler (rgd-diff.py) had exactly this fail-open: a missing log became an empty
    // set, the intersection emptied, and the verdict came out clean. This one handles it, and the
    // test pins it so the two cannot drift apart again.
    const red = 'FAIL src/a.spec.ts\n';
    expect(intersect([red, null, red]).stable, 'a missing attempt log produced a baseline').toBe(false);
  });

  it('an all-green attempt does not produce a tolerated baseline either', () => {
    expect(intersect(['ok\n', 'ok\n']).stable).toBe(false);
  });

  it('an unreadable result is never mistaken for "stable"', () => {
    // json-bool decides whether a RED guard becomes a PASSING one.
    expect(jsonBool('{"stable":true}', 'stable'), 'a stable result was rejected').toBe(0);
    expect(jsonBool('{"stable":false}', 'stable')).toBe(1);
    expect(jsonBool('not json', 'stable'), 'garbage was read as stable').toBe(1);
    expect(jsonBool('{}', 'stable'), 'a missing field was read as stable').toBe(1);
  });

  it('the failure names the mechanism that would have tolerated it', () => {
    // Otherwise the operator is told to fix inherited failures — the one thing policy says they
    // are not expected to do.
    const body = code();
    const i = body.indexOf('Regression guard FAILED');
    expect(i, 'the failure branch is gone').toBeGreaterThan(-1);
    const block = body.slice(i, i + 1400);
    expect(block, 'a project with no testFailurePattern is not told the mechanism exists')
      .toMatch(/testFailurePattern/);
    expect(block, 'it still tells every project to fix the previous phase’s tests unconditionally')
      .toMatch(/if \[ -z "\$\{_rg_pattern:-\}" \]/);
  });

  it('no inline python program is left deciding the verdict', () => {
    const body = code();
    const i = body.indexOf('rg-intersect.py');
    expect(body.slice(i, i + 900), 'an inline python program still decides whether to tolerate')
      .not.toMatch(/python3 -c/);
  });
});
