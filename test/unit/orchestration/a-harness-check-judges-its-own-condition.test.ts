/**
 * A HARNESS CHECK JUDGES ITS OWN CONDITION — NOT WHATEVER RAN ON THE LINE BEFORE.
 *
 * greenfield-harness.sh asserted eight conditions as `[ X ]; check $? "..."`: the status of a test
 * read on the next statement. Anything inserted between the two silently changes what is checked
 * (shellcheck SC2319, eleven new shell defects failed pre-flight on 2026-09-24). check_that takes
 * the condition itself. Driven through the harness's real check and check_that.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const H = join(__dirname, '../../../orchestrations/scripts/greenfield-harness.sh');
// Both are one-line definitions, which engine-source's shellFunction (closing brace at column 0)
// cannot lift — it runs on into the harness body. Lifted by their own line, and required to exist.
const oneLiner = (name: string) => {
  const line = readFileSync(H, 'utf8').split('\n').find((l) => l.startsWith(`${name}() {`) && l.trimEnd().endsWith('}'));
  if (!line) throw new Error(`${name}() is not a one-line definition in ${H} any more — lift it another way`);
  return line;
};
const FNS = [oneLiner('check'), oneLiner('check_that')].join('\n');

function run(script: string) {
  const r = spawnSync('bash', ['-c', `say(){ echo "PASS $*"; }; red(){ echo "FAIL $*"; }; FAILS=()\n${FNS}\n${script}\necho "fails=\${#FAILS[@]}"`], { encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}

describe('a harness check judges its own condition', () => {
  it('a true condition passes and a false one is recorded as a failure', () => {
    const out = run(`n=3; check_that "at least three" "$n" -ge 3; n=2; check_that "at least three again" "$n" -ge 3`);
    expect(out).toContain('PASS ✓ at least three');
    expect(out).toContain('FAIL at least three again');
    expect(out).toContain('fails=1');
  });

  it('what ran just before cannot decide the verdict — the form it replaces could not say that', () => {
    const out = run(`false; check_that "file exists" -f /etc/hostname; true; check_that "missing file" -f /no/such/file`);
    expect(out).toContain('PASS ✓ file exists');
    expect(out).toContain('FAIL missing file');
    expect(out).toContain('fails=1');
  });

  it('an empty path is not a non-empty file — the ledger check the && form made', () => {
    const out = run(`gl=""; check_that "ledger recorded" -s "$gl"`);
    expect(out).toContain('FAIL ledger recorded');
  });

  it('the harness no longer reads a condition status on the following statement', () => {
    const r = spawnSync('shellcheck', ['-S', 'warning', '-i', 'SC2319', H], { encoding: 'utf8' });
    if (r.error) return;                                   // no shellcheck here: pre-flight owns this
    expect(r.stdout, r.stdout).toBe('');
  });
});
