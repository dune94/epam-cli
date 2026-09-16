/**
 * "LINT COULD NOT RUN" MUST NOT LOOK LIKE "LINT FOUND NOTHING".
 *
 * run_repo_lint_verification is the check that puts the repository's own lint findings in front
 * of the writer — it sets VERIFICATION_FAILURE, which is the one channel the next attempt and
 * the failure analyst both read. It had three silent exits:
 *
 *     [ -n "$_hook" ]       || return 0     # no pre-commit hook found
 *     [ -n "$_eslint_bin" ] || return 0     # no eslint binary
 *     [ -n "$_changed" ]    || return 0     # nothing changed
 *
 * The first two mean THE CHECK NEVER HAPPENED, and returned success. A run in which lint was
 * never executed was indistinguishable, in the log and in the exit code, from a run in which
 * lint passed. That is the same fail-open shape as the rest of this week: unknown reported as
 * fine.
 *
 * The story is NOT failed for these — a writer cannot install a linter, and failing it would
 * make every project without eslint unwinnable. What changes is that the run SAYS SO.
 *
 * The third exit is different and stays quiet-but-logged: the check ran and had no subject.
 *
 * THE TEST EXECUTES THE REAL FUNCTION, lifted from claude.sh, against real temp directories —
 * a source grep would pass on the comment that describes the fix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

/** Lift a shell function out of claude.sh so the REAL body runs. */
function lift(name: string): string {
  const start = src.indexOf(`${name}() {`);
  expect(start, `${name} not found in claude.sh`).toBeGreaterThan(0);
  const end = src.indexOf('\n}\n', start) + 3;
  return src.slice(start, end);
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

interface Run { rc: number; out: string; vf: string }

function run(opts: { hook: boolean; eslint: boolean; changed: boolean }): Run {
  const dir = mkdtempSync(join(tmpdir(), 'repo-lint-')); dirs.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.ts'), 'export const a = 1;\n');
  // node_modules must be ignored, or the stub linter binary is itself an untracked "changed
  // file" and the no-changes case never occurs.
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  if (opts.hook) {
    mkdirSync(join(dir, '.husky'), { recursive: true });
    writeFileSync(join(dir, '.husky/pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
  }
  if (opts.eslint) {
    // THE CODELINE DECLARES ITS LINT (package.json scripts.lint); the engine names no linter and
    // hunts for no binary (2026-09-16). The declared script runs a clean stand-in, which proves
    // the "ran and found nothing" path is distinguishable from "could not run".
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    const bin = join(dir, 'node_modules/.bin/eslint');
    writeFileSync(bin, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { lint: 'eslint' } }));
  }
  // Baseline committed AFTER the hook exists: an untracked .husky/pre-commit is itself a
  // "changed file", which silently defeated the no-changes case.
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);

  if (opts.changed) writeFileSync(join(dir, 'touched.ts'), 'export const b = 2;\n');

  const out = execFileSync('bash', ['-c', `set +e
    # THIS MACHINE HAS /usr/bin/eslint, so no PATH trimming can produce the "no linter" case
    # while git still works. Hide the lookup itself instead — precise, and it leaves every
    # other command alone.
    PROJECT_ROOT=${JSON.stringify(dir)}
    SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}
    AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}
    NODE_BIN=${JSON.stringify(process.execPath)}
    VERIFICATION_FAILURE=""
    warning() { echo "WARN:$*"; }; error() { echo "ERR:$*"; }
    log() { echo "LOG:$*"; }; info() { :; }; success() { :; }
    engine_paths_filter() { cat; }
    is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
${lift('_run_declared_lint_gate')}
${lift('run_repo_lint_verification')}
    run_repo_lint_verification S1 /dev/null; echo "RC=$?"
    echo "__VF__"; printf '%s' "$VERIFICATION_FAILURE"`], { encoding: 'utf8' });

  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1]),
    out,
    vf: (out.split('__VF__')[1] ?? '').trim(),
  };
}

describe('the harness runs the real function', () => {
  it('a fully-equipped repo with a clean linter passes quietly', () => {
    const r = run({ hook: true, eslint: true, changed: true });
    expect(r.rc, r.out).toBe(0);
    expect(r.vf, 'a clean lint produced a verification failure').toBe('');
    expect(r.out, 'a clean run should not warn that lint could not run')
      .not.toMatch(/was NOT run/);
  });
});

describe('A CHECK THAT COULD NOT RUN SAYS SO', () => {
  it('no pre-commit hook is announced, not swallowed', () => {
    const r = run({ hook: false, eslint: true, changed: true });
    expect(r.out, 'lint silently did not run and the run reported nothing')
      .toMatch(/was NOT run/);
    expect(r.out).toMatch(/pre-commit hook/i);
  });

  it('no declared lint is announced, not swallowed — and no tool is named', () => {
    const r = run({ hook: true, eslint: false, changed: true });
    expect(r.out, 'lint silently did not run and the run reported nothing')
      .toMatch(/was NOT run/);
    expect(r.out).toMatch(/declares no lint command/i);
    expect(r.out, 'the engine must not name a linter it prefers').not.toMatch(/eslint/i);
  });

  it('and neither FAILS the story — the writer cannot install a linter', () => {
    // Failing here would make every project without eslint unwinnable. The requirement is
    // visibility, not enforcement.
    expect(run({ hook: false, eslint: true, changed: true }).rc).toBe(0);
    expect(run({ hook: true, eslint: false, changed: true }).rc).toBe(0);
  });

  it('the warning does not claim the change is clean', () => {
    const r = run({ hook: false, eslint: true, changed: true });
    expect(r.out).toMatch(/nothing here proves the change is clean/i);
  });
});

describe('"NOTHING TO LINT" IS A DIFFERENT STATEMENT', () => {
  it('no changed files is logged as having no subject, not as unable to run', () => {
    const r = run({ hook: true, eslint: true, changed: false });
    expect(r.rc).toBe(0);
    expect(r.out, 'an empty subject was reported as a broken check')
      .not.toMatch(/was NOT run/);
    expect(r.out).toMatch(/no changed files/i);
  });
});
