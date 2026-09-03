import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A MATCH MUST NOT BE REPORTED AS A FAILURE.
 *
 * _is_testable_source ends in:
 *
 *     printf '%s\n' "$_TESTABLE_SET" | grep -Fxq "$_f"
 *
 * `grep -q` exits the moment it matches. On a real codeline the set is thousands of lines, so
 * printf is still writing when the pipe closes and dies of SIGPIPE. The script runs under
 * `set -o pipefail`, which takes the WORST status in the pipeline — so a successful match returns
 * 141 (128+13) and every file is judged "not testable source".
 *
 * Live 2026-09-02, AMSD-1919 (3,070-line set): the stage reported "no testable source file in the
 * change" and wrote no bug-reproduction test, so the fix shipped untested. Measured rc=141 with the
 * target present in the set at line 1696.
 *
 * It is SIZE-dependent, which is why a small fixture passes: with a handful of lines printf
 * finishes before grep exits and no SIGPIPE occurs. The set here is deliberately large.
 */
describe('_is_testable_source, on a set the size of a real codeline', () => {
  const script = path.resolve(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');

  it('reports a file that IS in the set as testable, not as a pipeline failure', () => {
    const body = fs.readFileSync(script, 'utf8');
    const fn = body.match(/_is_testable_source\(\)\s*\{[\s\S]*?\n\}/);
    expect(fn, '_is_testable_source not found').toBeTruthy();

    const target = 'src/components/pages/CheckoutPage/CheckoutForm.tsx';
    // A set the shape of a real one: the target early, thousands of lines still to write after it.
    const many = Array.from({ length: 3000 }, (_, i) => `src/generated/file${i}.tsx`);
    many.splice(1696, 0, target);

    const harness = `
set -uo pipefail
SCRIPT_DIR="${path.resolve(__dirname, '../../../orchestrations/scripts')}"
PROJECT_ROOT="/nonexistent"
_TESTABLE_RESOLVED=1
_TESTABLE_SET="$(echo '${target}'; for i in $(seq 1 4000); do echo \"src/components/deeply/nested/generated/area$i/subarea$i/file$i.tsx\"; done)"
${fn![0]}
if _is_testable_source "${target}"; then echo TESTABLE; else echo "NOT_TESTABLE rc=$?"; fi
`;
    const r = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

    expect(out.length, 'harness produced nothing — vacuous pass').toBeGreaterThan(0);
    expect(out, `a present file was judged untestable.\n--- output ---\n${out}`).toContain('TESTABLE');
    expect(out).not.toContain('NOT_TESTABLE');
  });
});
