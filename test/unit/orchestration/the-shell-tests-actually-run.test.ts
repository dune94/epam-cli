/**
 * 462 SHELL TESTS, ZERO EXECUTED, EXIT 0.
 *
 * 57 .bats files sit in this repo and none of them ran. `bats` on this machine exits 0 having
 * executed nothing — its wrapper loses BATS_LIBEXEC, so the inner runner cannot find bats-exec-test
 * and every file "passes" in silence. Nothing in package.json, vitest.config.ts or the shard runner
 * referenced .bats at all, so there was no second chance to notice.
 *
 * Among the files that never ran: the hardcoding audit's own calibration tests — the ones proving
 * each category can still SEE. A detector going blind, and a suite unable to notice, is the exact
 * pairing that audit exists to prevent.
 *
 * The first version of the runner written to fix this trusted the TAP plan bats prints — and bats
 * prints none, so "planned 0, executed 0" read as success and all 57 files passed having run
 * nothing. The silent pass reintroduced inside the fix for it, within the hour. The file's own
 * @test count is the truth.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const RUNNER = join(ROOT, 'orchestrations/scripts/run-shell-tests.sh');

function batsFiles(dir = join(ROOT, 'test')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...batsFiles(p));
    else if (e.endsWith('.bats')) out.push(p);
  }
  return out;
}

describe('THE SHELL TESTS HAVE A RUNNER THAT CANNOT LIE', () => {
  it('there are shell tests to run — otherwise this passes vacuously', () => {
    const files = batsFiles();
    expect(files.length).toBeGreaterThan(10);
    const declared = files.reduce((n, f) =>
      n + (readFileSync(f, 'utf8').match(/^\s*@test\s/gm) || []).length, 0);
    expect(declared, 'no @test blocks found').toBeGreaterThan(100);
  });

  it('a file that declares tests but executes none is a FAILURE, not a pass', () => {
    // The property that matters. Run for real: if bats is broken here — as it is — the runner must
    // exit non-zero and say which files never ran.
    const r = spawnSync('bash', [RUNNER], { encoding: 'utf8', timeout: 600000, cwd: ROOT });
    const out = (r.stdout || '') + (r.stderr || '');
    const executed = Number((out.match(/executed=(\d+)/) || [])[1] ?? -1);
    if (executed === 0) {
      expect(r.status, 'the runner reported success while executing NOTHING — the defect it exists '
        + 'to prevent, in the runner itself').not.toBe(0);
      expect(out).toMatch(/executed 0/);
    } else {
      // bats works here: then a real failure must still fail the runner.
      expect(out).toMatch(/executed=\d+/);
    }
  });

  it('the runner counts @test blocks rather than trusting the plan bats prints', () => {
    // bats prints no TAP plan on this machine, so a runner keyed on the plan reads
    // "planned 0, executed 0" as success — which it did, for all 57 files.
    expect(readFileSync(RUNNER, 'utf8')).toMatch(/grep -cE '\^\[\[:space:\]\]\*@test/);
  });

  it('and refuses outright when bats is not installed', () => {
    const r = spawnSync('bash', ['-c',
      `PATH=/nonexistent bash ${JSON.stringify(RUNNER)}`], { encoding: 'utf8', timeout: 120000, cwd: ROOT });
    expect(r.status, 'a missing runner must not read as "all shell tests passed"').not.toBe(0);
  });
});
