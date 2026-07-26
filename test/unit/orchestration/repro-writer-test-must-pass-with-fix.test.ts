/**
 * ROOT CAUSE: the writer runs AFTER the fix is committed, but validates as though
 * the fix were absent.
 *
 * Pipeline order (run-agent-orchestration.sh):
 *   1. story execution  -> commits the FIX
 *   2. repro-test-writer -> writes the test   <- the fix is ALREADY in the tree
 *   3. repro-gate        -> judges it
 *
 * _validate_written_test decides on numTotalTests > 0, with this reasoning:
 *
 *   "An assertion failure IS valid here — a reproducing test is SUPPOSED to fail
 *    before the fix."
 *
 * That premise is inverted in this pipeline. The fix is not "before" — it is
 * already committed. So a failing assertion does NOT mean "correctly reproduces
 * the bug"; it means the test CONTRADICTS the fix that is already there. The
 * writer accepts it, commits it, and the repro-gate then reports precisely that:
 *
 *   BLOCK: the new test(s) FAIL with the fix in place — the fix is incomplete or
 *   the test is wrong.
 *
 * The rule licensed the very failure it was written to prevent.
 *
 * THE SPLIT, confirmed from the gate's own contract ("fails on the pre-fix
 * baseline, passes with the fix"):
 *   writer     owns "passes WITH the fix"      — it can still retry and escalate
 *   repro-gate owns "fails WITHOUT the fix"    — it alone can check out the baseline
 *
 * Catching it in the writer matters because that is the only moment anything can
 * act: it holds retries, a model ladder, and (since the typecheck work) a proven
 * ability to use concrete failure detail fed back into the next attempt.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const WRITER_SH = join(REPO, 'orchestrations/scripts/brownfield-repro-test-writer.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repoWith(specBody: string) {
  const d = mkdtempSync(join(tmpdir(), 'passfix-')); dirs.push(d);
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'package.json'), '{"name":"t","private":true}');
  symlinkSync(join(REPO, 'node_modules'), join(d, 'node_modules'));
  writeFileSync(join(d, 'src', 'x.spec.ts'), specBody);
  return d;
}

function validate(dir: string): number {
  const fnFile = join(dir, '_fn.sh');
  execFileSync('bash', ['-c',
    `sed -n '/^_typecheck_written_test() {/,/^}/p' ${JSON.stringify(WRITER_SH)} > ${JSON.stringify(fnFile)} && ` +
    `sed -n '/^_validate_written_test() {/,/^}/p' ${JSON.stringify(WRITER_SH)} >> ${JSON.stringify(fnFile)}`]);
  const script = [
    'set -uo pipefail',
    `PROJECT_ROOT=${JSON.stringify(dir)}`,
    `NODE_BIN=${JSON.stringify(process.execPath)}`,
    '_writer_log=/dev/null',
    `source ${JSON.stringify(fnFile)}`,
    '_validate_written_test "src/x.spec.ts"; echo "RC=$?"',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return Number((out.match(/RC=(\d+)/) || [])[1] ?? -1);
}

const PASSING = `
import { describe, it, expect } from 'vitest';
describe('discount', () => { it('applies', () => { expect(1 + 1).toBe(2); }); });
`;

/** Runs, but its assertion contradicts the already-committed fix. */
const FAILING_ASSERTION = `
import { describe, it, expect } from 'vitest';
describe('discount', () => { it('applies', () => { expect(1 + 1).toBe(3); }); });
`;

describe('the written test must pass against the committed fix', () => {
  it('REJECTS a test whose assertion fails — the fix is already in the tree', () => {
    const rc = validate(repoWith(FAILING_ASSERTION));
    expect(rc,
      'a test contradicting the committed fix was accepted and committed; the ' +
      'repro-gate then blocks one step later, where nothing can retry it')
      .not.toBe(0);
  }, 120000);

  it('ACCEPTS a test that passes', () => {
    expect(validate(repoWith(PASSING)), 'a valid test was rejected').toBe(0);
  }, 120000);

  it('the repro-gate still owns the baseline direction', () => {
    const src = execFileSync('cat',
      [join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh')], { encoding: 'utf8' });
    // The writer must NOT try to check out the baseline; that is the gate's job.
    expect(src).toMatch(/fails on the pre-fix baseline, passes with the fix/);
  });
});
