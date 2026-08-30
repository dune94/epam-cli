/**
 * A RETRY THAT LOSES ITS CORRECTIVE PREFIX IS THE FAILED ATTEMPT, RUN AGAIN.
 *
 * The tools-audit retry builds its prefix from a syntax check of the file it just produced:
 *
 *     _tc_bn_err=$(bash -n "$_tc_path" 2>&1 || true)
 *
 * `bash -n` prints NOTHING when the file parses — which is the usual case, because this retry
 * fires after a failure and most failures are not syntactic. The empty value made the retry-prefix
 * render refuse, and the handler fell back:
 *
 *     warning "could not render the retry prefix — retrying with the original prompt"
 *
 * So the second attempt was byte-identical to the first: the same prompt, the same model, no
 * statement of what went wrong. An unwinnable loop that reports itself as a rendering hiccup.
 *
 * The fix is NOT to declare the placeholder optional — an empty error section makes the agent
 * answer about silence, which is what that guard exists to prevent. It is to say what was
 * observed, the idiom this repo already uses for the analyst's "(empty — it produced nothing)".
 *
 * Asserted by EXECUTING the two lines out of the script, so a change to them fails this test.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

/**
 * Run the real capture-and-default lines against a file, and report the value they produce.
 * Spliced from the script by anchor rather than retyped, so the test cannot drift from it.
 */
function tcBnErrFor(fileBody: string): string {
  const src = readFileSync(ORCH, 'utf8').split('\n');
  const start = src.findIndex((l) => /_tc_bn_err=\$\(bash -n "\$_tc_path"/.test(l));
  expect(start, 'the syntax-check capture is gone — the shape has changed').toBeGreaterThan(-1);
  // Take that line plus the guard that follows it, skipping comments.
  const block = src.slice(start, start + 12)
    .filter((l) => !/^\s*#/.test(l))
    .slice(0, 3)
    .join('\n');
  expect(block, 'the spliced block does not contain the capture').toMatch(/bash -n/);

  const work = mkdtempSync(join(tmpdir(), 'tc-bn-'));
  const target = join(work, 'tool.sh');
  writeFileSync(target, fileBody);
  const r = spawnSync('bash', ['-c', `
    _tc_path=${JSON.stringify(target)}
    ${block}
    printf '%s' "$_tc_bn_err"
  `], { encoding: 'utf8', timeout: 60000 });
  return r.stdout ?? '';
}

describe('a retry states what it observed, even when the observation is clean', () => {
  it('a file with a real syntax error reports the error', () => {
    // The negative half: the default must not replace a genuine diagnostic.
    const v = tcBnErrFor('if [ -z "$x" ; then echo hi\n');
    expect(v.trim().length, 'a real syntax error produced nothing').toBeGreaterThan(0);
    expect(v, 'the default overwrote a real syntax error').not.toMatch(/parses cleanly/);
  }, 60_000);

  it('a file that parses cleanly still says so', () => {
    // The defect: this was empty, the retry prefix refused to render, and the retry ran the
    // original prompt unchanged.
    const v = tcBnErrFor('echo hello\n');
    expect(v.trim().length,
      'a clean parse produced an EMPTY value — the retry prefix cannot render, and the retry '
      + 'repeats the attempt that just failed').toBeGreaterThan(0);
  }, 60_000);

  it('and the value it produces is one the template will render', () => {
    // The receiving end: whatever this yields must satisfy the emptiness guard, or the fix has
    // moved the failure rather than removed it.
    const v = tcBnErrFor('echo hello\n');
    expect(v.trim(), 'the value would still be rejected as empty by prompt-library').not.toBe('');
  }, 60_000);
});
