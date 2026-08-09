/**
 * THE REPO'S OWN LINT MUST RUN BEFORE THE COMMIT, NOT AT STEP 20.
 *
 * Live 2026-08-09, AMSD-2041 on gotransit. The writer produced correct code and `tsc --noEmit`
 * passed. Then the commit fired the client repo's husky pre-commit hook:
 *
 *     ✖ eslint src/services/contentstack.ts
 *       58:7  error  'CONTENTSTACK_DEFAULT_PREVIEW_HOST' is assigned a value but never used
 *     ✖ 1 problem (1 error, 0 warnings)
 *     husky - pre-commit hook exited with code 1
 *     [STARTED] Reverting to original state because of errors...
 *
 * lint-staged reverts the working tree when a task fails, so ONE unused constant destroyed the
 * whole attempt. The loop then reset the worktree to origin/develop ("no validated state to
 * preserve") and started again from nothing — and would have hit the identical wall on every
 * one of its 8 attempts, because nothing in the loop ever told the writer that rule existed.
 *
 * We do run eslint — at Step 20, which is AFTER the per-story commit at Step 8/9. So the gate
 * that could have caught this runs only on work that already committed successfully. For the
 * story that cannot commit, it never runs at all.
 *
 * The check belongs beside run_tsc_verification, inside the retry loop, where a failure is
 * feedback the writer can act on rather than a destructive commit failure.
 *
 * SCOPE IS THE CHANGED FILES, deliberately: that is exactly what lint-staged lints, so this
 * reproduces the hook's verdict. Linting the whole tree would fail every story in any brownfield
 * repo carrying pre-existing violations in files no story touches — the same trap
 * run_tsc_verification already had to escape with baseline diffing.
 *
 * It runs only where the repo ENFORCES lint at commit time (a pre-commit hook exists). Imposing
 * it on a repo with no such hook would fail stories for a standard the repo itself does not hold.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The shipped function, lifted verbatim. */
function shippedFn(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('run_repo_lint_verification() {');
  expect(start, 'run_repo_lint_verification not found in claude.sh').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 3);
}

/**
 * A repo shaped like next.gotransit.com: git, a husky pre-commit hook, an eslint binary that
 * reports the real unused-var error, and a committed baseline.
 */
function repo(opts: { hook?: boolean; eslint?: boolean; dirtyFileClean?: boolean; engineArtifacts?: boolean; hooksPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'repolint-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src', 'services'), { recursive: true });
  // A file the story never touches, carrying a PRE-EXISTING violation.
  // Real repos ignore node_modules, and so must the fixture: without it the stubbed eslint
  // binary counts as an untracked "changed file" and gets linted, which is not a condition that
  // exists in any real repository.
  writeFileSync(join(dir, '.gitignore'), 'node_modules\nfeedback.txt\n');
  writeFileSync(join(dir, 'src', 'untouched.ts'), 'const OLD_UNUSED = 1;\n');
  writeFileSync(join(dir, 'src', 'services', 'contentstack.ts'), 'export const ok = 1;\n');
  git('add', '.'); git('commit', '-qm', 'baseline');

  if (opts.hook !== false) {
    // The live repo sets core.hooksPath=.husky, so the FIRST discovery branch is the one that
    // matters in production. Omitting it made the fixture pass through the .husky fallback
    // instead, and deleting the hooksPath branch outright left every test green — the live path
    // was untested. hooksPath is configurable to any directory, so it is parameterised here
    // rather than assumed to equal .husky.
    const hp = opts.hooksPath ?? '.husky';
    mkdirSync(join(dir, hp), { recursive: true });
    writeFileSync(join(dir, hp, 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
    execFileSync('git', ['-C', dir, 'config', 'core.hooksPath', hp]);
  }
  if (opts.eslint !== false) {
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    // Stands in for the repo's eslint + its config: any file containing UNUSED_MARKER is an
    // error, mirroring @typescript-eslint/no-unused-vars on the live file.
    writeFileSync(join(bin, 'eslint'),
      `#!/usr/bin/env bash\n` +
      // --print-config is the "do you have a config for this path?" probe and always exits 0
      // on a lintable file, exactly like real eslint. Getting this wrong made every file look
      // unlintable and the gate silently passed.
      `if [ "$1" = "--print-config" ]; then echo "{}"; exit 0; fi\n` +
      `rc=0\nfor f in "$@"; do\n` +
      `  case "$f" in -*) continue ;; esac\n` +
      `  if [ -f "$f" ] && grep -q UNUSED_MARKER "$f"; then\n` +
      `    echo "$f"; echo "  58:7  error  'CONTENTSTACK_DEFAULT_PREVIEW_HOST' is assigned a value but never used  @typescript-eslint/no-unused-vars"; rc=1\n` +
      `  fi\ndone\n[ $rc -ne 0 ] && echo "✖ 1 problem (1 error, 0 warnings)"\nexit $rc\n`);
    chmodSync(join(bin, 'eslint'), 0o755);
  }
  if (opts.engineArtifacts) {
    // Exactly what next.gotransit.com carries during a run: untracked, NOT gitignored, and
    // accepted by eslint's flat config. Contains the marker so a gate that lints it fails.
    mkdirSync(join(dir, '.epam'), { recursive: true });
    writeFileSync(join(dir, '.epam', 'settings.json'), '{"UNUSED_MARKER": true}\n');
  }
  // The story's change: the exact defect that killed the live run.
  writeFileSync(join(dir, 'src', 'services', 'contentstack.ts'),
    opts.dirtyFileClean
      ? 'export const ok = 2;\nexport const used = ok;\n'
      : 'export const ok = 2;\nconst UNUSED_MARKER = "https://rest-preview.contentstack.com";\n');
  return dir;
}

/** Runs the real function against a repo; returns exit code and the feedback it wrote. */
function runGate(dir: string, env: Record<string, string> = {}) {
  const out = join(dir, 'feedback.txt');
  writeFileSync(out, '');
  const res = execFileSync('bash', ['-c',
    `set -u
     PROJECT_ROOT=${JSON.stringify(dir)}
     LOG_DIR=${JSON.stringify(dir)}
     is_truthy() { case "$1" in true|1|yes|TRUE|True) return 0 ;; *) return 1 ;; esac; }
     log() { echo "LOG:$*"; }; error() { echo "ERR:$*"; }
     warning() { echo "WARN:$*"; }; success() { echo "OK:$*"; }; info() { echo "INFO:$*"; }
     ${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n')}
     # Mirrors production: claude.sh sources lib/git-ops.sh, which sources lib/engine-paths.sh.
     # engine_paths_filter must be in scope or the gate's pipeline yields nothing and passes.
     . ${JSON.stringify(join(__dirname, '../../../orchestrations/scripts/lib/engine-paths.sh'))}
${shippedFn()}
     run_repo_lint_verification STORY-1 ${JSON.stringify(out)}; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  return { rc: Number((res.match(/RC=(\d+)/) || [])[1]), log: res, feedback: readFileSync(out, 'utf8') };
}

describe('the fixture reproduces the live condition', () => {
  it('the changed file carries the violation and the untouched file carries a pre-existing one', () => {
    const dir = repo();
    expect(readFileSync(join(dir, 'src/services/contentstack.ts'), 'utf8')).toContain('UNUSED_MARKER');
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }))
      .toContain('src/services/contentstack.ts');
  });

  it("the repo's own eslint really does fail on it — otherwise every check below is vacuous", () => {
    const dir = repo();
    let rc = 0;
    try {
      execFileSync(join(dir, 'node_modules/.bin/eslint'), [join(dir, 'src/services/contentstack.ts')]);
    } catch (e: any) { rc = e.status; }
    expect(rc, 'the stubbed eslint passed, so the gate has nothing to catch').toBe(1);
  });
});

describe('THE DEFECT: the violation is caught before the commit', () => {
  it('the gate fails the attempt', () => {
    expect(
      runGate(repo()).rc,
      'the story proceeds to commit, husky rejects it, and lint-staged reverts the work away',
    ).not.toBe(0);
  });

  it('the feedback names the file, the rule and the symbol so the writer can fix it', () => {
    const { feedback } = runGate(repo());
    expect(feedback).toContain('src/services/contentstack.ts');
    expect(feedback).toContain('no-unused-vars');
    expect(feedback).toContain('CONTENTSTACK_DEFAULT_PREVIEW_HOST');
  });

  it('it says why it is failing, not just that it failed', () => {
    expect(runGate(repo()).log).toMatch(/lint|eslint/i);
  });
});

describe('it does not fail stories for things they did not do', () => {
  it('a clean change passes even though an untouched file still violates', () => {
    const { rc } = runGate(repo({ dirtyFileClean: true }));
    expect(rc, 'a pre-existing violation in an untouched file failed the story').toBe(0);
  });

  it('a repo with no pre-commit hook is not subjected to the gate', () => {
    // No hook means the repo does not enforce lint at commit time; failing the story would
    // hold it to a standard the repo itself does not.
    expect(runGate(repo({ hook: false })).rc).toBe(0);
  });

  it('a repo with no eslint binary skips rather than erroring', () => {
    expect(runGate(repo({ eslint: false })).rc).toBe(0);
  });

  it('SKIP_STORY_LINT_GATE=true bypasses it', () => {
    expect(runGate(repo(), { SKIP_STORY_LINT_GATE: 'true' }).rc).toBe(0);
  });

  it('a clean tree with nothing changed passes', () => {
    const dir = repo({ dirtyFileClean: true });
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'work']);
    expect(runGate(dir).rc).toBe(0);
  });
});

describe("engine artefacts are not the story's code", () => {
  it('a violation inside .epam/ does not fail the story', () => {
    // Live check on next.gotransit.com: `.epam/settings.json` and `.epam/codeline-facts.json`
    // are untracked, not gitignored, and eslint --print-config ACCEPTS them. The commit
    // deliberately excludes engine-owned paths (lib/engine-paths.sh), so linting them would
    // fail stories over the engine's own state — work the writer neither produced nor can fix.
    const { rc } = runGate(repo({ dirtyFileClean: true, engineArtifacts: true }));
    expect(rc, "the gate linted the engine's own artefacts and failed the story").toBe(0);
  });

  it("the story's real violation is still caught with engine artefacts present", () => {
    // The paired positive: excluding engine paths must not excuse the client code beside them.
    expect(runGate(repo({ engineArtifacts: true })).rc).not.toBe(0);
  });
});

describe('the engine-path filter is actually reachable from claude.sh', () => {
  it("claude.sh's own source chain defines engine_paths_filter", () => {
    // Not pedantry: an undefined function in that pipeline makes the changed-file list EMPTY,
    // so the gate returns 0 and passes everything. It would fail open exactly like the coverage
    // gate did, and just as silently. claude.sh gets it via lib/git-ops.sh; if someone drops
    // that source line, this fails instead of the gate quietly going inert.
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh'))} >/dev/null 2>&1
       command -v engine_paths_filter >/dev/null && echo DEFINED || echo MISSING`,
    ], { encoding: 'utf8' });
    expect(out.trim()).toBe('DEFINED');
  });

  it('it really filters engine paths and keeps client paths', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(join(__dirname, '../../../orchestrations/scripts/lib/engine-paths.sh'))} >/dev/null 2>&1
       printf '%s\\n' 'src/a.ts' '.epam/settings.json' 'src/orchestrations-ui/App.tsx' | engine_paths_filter`,
    ], { encoding: 'utf8' });
    const kept = out.trim().split('\n');
    expect(kept).toContain('src/a.ts');
    expect(kept, 'a client path with a similar name was dropped').toContain('src/orchestrations-ui/App.tsx');
    expect(kept).not.toContain('.epam/settings.json');
  });
});

/**
 * The function being correct is worth nothing if the loop never calls it. Removing the call site
 * entirely left all 14 tests above green — the same inertness that let the coverage gate log a
 * block it never enforced. This executes the SHIPPED verification chain with the individual
 * checks stubbed, so it fails if the wiring is removed, reordered past the point of usefulness,
 * or made unreachable.
 */
describe('the gate is actually wired into the writer loop', () => {
  /** Lifts the real verification chain and runs it with each check stubbed to a chosen verdict. */
  function runChain(verdicts: { tsc?: number; lint?: number; ext?: number }) {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('        local _invoke_success_before_tsc="$invoke_success"');
    expect(start, 'the verification chain was not found').toBeGreaterThan(-1);
    const endMark = 'deliverables written but external tests failed';
    const end = src.indexOf(endMark, start);
    expect(end, 'the chain terminator moved').toBeGreaterThan(start);
    const block = src.slice(start, src.indexOf('\n', end) + 1) + '        fi\n';

    // The chain uses `local`, so it must run inside a function — exactly as it does in
    // implement_story. Running it at top level fails with "local: can only be used in a
    // function" and would look like a wiring failure when it is a harness one.
    const out = execFileSync('bash', ['-c',
      `set -u
       invoke_success=true; story_id=S1; output_file=/dev/null; story_cli=epam
       LAST_ATTEMPT_TSC_PASSED=false
       warning() { echo "WARN:$*"; }
       run_tsc_verification()      { echo "CALLED:tsc";  return ${verdicts.tsc ?? 0}; }
       run_repo_lint_verification() { echo "CALLED:lint"; return ${verdicts.lint ?? 0}; }
       run_external_verification()  { echo "CALLED:ext";  return ${verdicts.ext ?? 0}; }
       _chain() {
${block}
       }
       _chain
       echo "invoke_success=$invoke_success"`,
    ], { encoding: 'utf8' });
    return {
      called: out.split('\n').filter((l) => l.startsWith('CALLED:')).map((l) => l.slice(7)),
      success: /invoke_success=true/.test(out),
      out,
    };
  }

  it('the lint gate is called when tsc passes', () => {
    expect(runChain({}).called, 'the gate is never invoked — it is inert').toContain('lint');
  });

  it('a lint failure fails the attempt', () => {
    const r = runChain({ lint: 1 });
    expect(r.success, 'the story proceeds to commit despite a lint failure').toBe(false);
  });

  it('it runs AFTER tsc and BEFORE the external test run', () => {
    // Order is the point: type errors first, and no full test run spent on a change that
    // cannot commit anyway.
    expect(runChain({}).called).toEqual(['tsc', 'lint', 'ext']);
  });

  it('a lint failure skips the external test run entirely', () => {
    expect(runChain({ lint: 1 }).called).toEqual(['tsc', 'lint']);
  });

  it('it is skipped when tsc already failed', () => {
    expect(runChain({ tsc: 1 }).called).toEqual(['tsc']);
  });

  it('a clean chain still succeeds', () => {
    const r = runChain({});
    expect(r.success).toBe(true);
  });
});

describe('the hook is found however the repo configures it', () => {
  it('via core.hooksPath pointing somewhere other than .husky', () => {
    // husky is not the only pre-commit manager, and hooksPath can name any directory. Only the
    // first discovery branch can find this one.
    expect(runGate(repo({ hooksPath: '.githooks' })).rc).not.toBe(0);
  });

  it('via .husky/pre-commit with no core.hooksPath set at all', () => {
    const d = repo();
    execFileSync('git', ['-C', d, 'config', '--unset', 'core.hooksPath']);
    expect(runGate(d).rc).not.toBe(0);
  });

  it('via the stock .git/hooks/pre-commit', () => {
    const d = repo({ hook: false });
    writeFileSync(join(d, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    expect(runGate(d).rc).not.toBe(0);
  });

  it('and a repo with none of the three is still left alone', () => {
    // The paired negative: the three branches must not collapse into "always run".
    expect(runGate(repo({ hook: false })).rc).toBe(0);
  });
});
