// A PASSING LINT RUN SAID NOTHING, SO IT LOOKED LIKE A LINT RUN THAT NEVER HAPPENED.
//
// run_repo_lint_verification speaks on three ABSENT-check paths — no pre-commit hook, no eslint
// binary, no changed files — under an explicit comment:
//
//   "AN ABSENT CHECK IS NOT A PASS. These three exits used to be silent `return 0`s, so 'lint
//    could not run' was indistinguishable from 'lint found nothing' — the same fail-open shape as
//    every other defect in this pipeline."
//
// The PASS path was left silent. So of the gate's states, failure is loud, absence is loud, and
// success is mute — and success is therefore indistinguishable from "never called".
//
// Live cost, 2026-08-19: an entire metrolinx writer run produced zero `repo-lint` lines. I read
// that as the gate never running, hypothesised that a veto was short-circuiting it, disproved that
// hypothesis, reported it to the operator as an open defect, and kept it open across several
// hours. Lint had almost certainly run and passed the whole time.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A repo with a hook, a stub eslint of the given exit code, and one CHANGED file. */
function repo(eslintExit: number, message = ''): string {
  const d = mkdtempSync(join(tmpdir(), 'lintsilent-')); made.push(d);
  const g = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  mkdirSync(join(d, 'src'), { recursive: true });
  mkdirSync(join(d, '.husky'), { recursive: true });
  mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(d, '.husky/pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
  const bin = join(d, 'node_modules/.bin/eslint');
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in --print-config) exit 0 ;; esac\n${message ? `echo "${message}"` : ''}\nexit ${eslintExit}\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(d, 'src/a.ts'), 'export const a = 1;\n');
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  g('add', '-A'); g('commit', '-qm', 'base');
  writeFileSync(join(d, 'src/a.ts'), 'export const a = 2;\n');   // a CHANGED file to lint
  return d;
}

function runGate(root: string) {
  const script = `
set +e
log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }
info(){ :; }; success(){ echo "OK: $*"; }
is_truthy(){ case "\${1:-}" in 1|true|yes) return 0;; *) return 1;; esac; }
PROJECT_ROOT=${JSON.stringify(root)}
SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
. "$SCRIPT_DIR/lib/engine-paths.sh"
eval "$(awk '/^run_repo_lint_verification\\(\\) \\{/,/^\\}/' ${JSON.stringify(SH)})"
run_repo_lint_verification TEST-1 /dev/null
echo "RC=$?"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? -1), out };
}

describe('every outcome of the lint gate is distinguishable from the others', () => {
  it('the fixture really does present changed files — else this proves nothing', () => {
    const d = repo(0);
    const status = execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status, 'no changed file, so the gate would exit on a different path').toMatch(/src\/a\.ts/);
  });

  it('THE DEFECT: a PASSING lint run says so', () => {
    const r = runGate(repo(0));
    expect(r.rc, 'a clean lint must not fail the story').toBe(0);
    expect(r.out, 'silence: a passing run is indistinguishable from a run that never happened')
      .toMatch(/repo-lint/);
  });

  it('a FAILING lint run still says so, and still fails', () => {
    const r = runGate(repo(1, '/src/a.ts  1:1  error  Unexpected any  @typescript-eslint/no-explicit-any'));
    expect(r.rc, 'a lint failure must fail the attempt — the hook would revert the work').toBe(1);
    expect(r.out).toMatch(/repo-lint/);
  });

  it('pass and fail are not confusable with each other', () => {
    const pass = runGate(repo(0)).out;
    const fail = runGate(repo(1, 'x  1:1  error  bad  some/rule')).out;
    expect(pass, 'a passing run reads as a rejection').not.toMatch(/rejects|REVERT/i);
    expect(fail, 'a failing run reads as a pass').toMatch(/rejects/i);
  });
});

// The second silent exit: changed files exist, but none survive the `eslint --print-config` filter
// (a file the project's config does not cover). The gate then examined NOTHING and said nothing —
// same shape as the silent pass, and it reads as a clean lint to anyone watching the log.
describe('a lint run that examined nothing says so', () => {
  it('reports when no changed file is covered by the eslint config', () => {
    const d = mkdtempSync(join(tmpdir(), 'lintnone-')); made.push(d);
    const g = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
    mkdirSync(join(d, '.husky'), { recursive: true });
    mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(d, '.husky/pre-commit'), '#!/bin/sh\n');
    // --print-config FAILS for every file: nothing is lintable.
    const bin = join(d, 'node_modules/.bin/eslint');
    writeFileSync(bin, '#!/bin/sh\ncase "$1" in --print-config) exit 2 ;; esac\nexit 0\n');
    chmodSync(bin, 0o755);
    writeFileSync(join(d, 'notes.md'), 'a\n');
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    g('add', '-A'); g('commit', '-qm', 'base');
    writeFileSync(join(d, 'notes.md'), 'b\n');

    const r = runGate(d);
    expect(r.rc, 'examining nothing must not fail the story').toBe(0);
    expect(r.out, 'the gate examined no file and said nothing — indistinguishable from a clean lint')
      .toMatch(/repo-lint/);
  });
});
