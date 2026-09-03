/**
 * A COMPLETENESS REJECTION IS NOT EVIDENCE THE WORK IS BROKEN.
 *
 * Found live 2026-08-09, run 20260809T213412, story AMSD-2041. The writer correctly implemented
 * 2 of the 4 spec-VERIFIED fix sites. verify_story_deliverables (claude.sh:9157) rejected the
 * story — correctly, it was incomplete. Then at the next rung transition every one of those
 * correct edits was deleted, and the following attempt started from an empty tree and re-derived
 * the same two files. Four attempts, same two files, same rejection, escalating model cost.
 *
 * The mechanism, traced end to end:
 *
 *   9157  verify_story_deliverables fails  -> invoke_success=false
 *   9217  the tsc gate is guarded on `[ "$invoke_success" = true ]`, so tsc NEVER RUNS
 *   9221  the if/else nonetheless records LAST_ATTEMPT_TSC_PASSED=false
 *   8636  _selective_worktree_reset reads false, concludes "no positive evidence anything here
 *         is good", and runs `git checkout origin/develop -- .` + `git clean -fd`
 *   688   LAST_VERIFIED_TOUCHED_FILES="" — so the work-carryover prompt note (#112), which
 *         exists precisely to tell the next attempt what is already done, is emptied too
 *
 * The defect is at 9221 and it is one of conflation: `false` is made to mean both "tsc ran and
 * the tree does not type-check" and "tsc never ran, so nothing is known about the tree". Only
 * the first is evidence of corruption. The second is evidence of nothing, and the reset treats
 * it as a conviction.
 *
 * Note what is NOT the fix: a list of which gates are allowed to preserve work. That is a
 * hardcoded policy that drifts the moment a gate is added. _selective_worktree_reset's own
 * docstring already names the signal it wants — "real, already-computed evidence the WHOLE tree
 * is at least type/syntax-correct". When that evidence was never computed, compute it: run the
 * check rather than guessing from a flag that was never set.
 *
 * Real git repositories and a real (stubbed-binary) tsc invocation throughout. The stub is what
 * decides each outcome, so a fixture that fails to reach tsc cannot pass by accident.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const cleanupDirs: string[] = [];
afterEach(() => { for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Lifts a function body out of claude.sh. Terminates on a closing brace in COLUMN ZERO —
 * `indexOf('\n}')` truncates at the first nested closing brace that happens to be indented to
 * nothing, which silently produces a syntactically valid but half-length function.
 */
function lift(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{$`, 'm').exec(SRC);
  if (!m) throw new Error(`no definition for ${name}()`);
  const end = SRC.indexOf('\n}\n', m.index);
  if (end < 0) throw new Error(`unterminated ${name}()`);
  return SRC.slice(m.index, end + 3);
}

/** A bare origin plus a working clone holding one tracked TypeScript file. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'partial-work-')); cleanupDirs.push(root);
  const origin = join(root, 'origin.git');
  mkdirSync(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: origin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd });
  git(seed, 'init', '--quiet', '--initial-branch=develop');
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'src/contentstack.ts'), 'export const original = 1;\n');
  writeFileSync(join(seed, 'tsconfig.json'), '{}\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed', '--quiet');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'develop', '--quiet');

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', origin, clone]);
  git(clone, 'config', 'user.email', 't@t'); git(clone, 'config', 'user.name', 't');
  return { root, clone };
}

/**
 * Installs the tsc the gate will actually run. run_tsc_verification invokes
 * `"$NODE_CMD" ./node_modules/.bin/tsc --noEmit` from PROJECT_ROOT, so NODE_CMD is a shim that
 * execs whatever script it is handed and .bin/tsc is what decides the exit code.
 */
function installTsc(clone: string, exit: number): string {
  const bin = join(clone, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tsc'),
    exit === 0
      ? '#!/usr/bin/env bash\nexit 0\n'
      : `#!/usr/bin/env bash\necho "src/contentstack.ts(3,1): error TS1005: ';' expected."\nexit ${exit}\n`);
  chmodSync(join(bin, 'tsc'), 0o755);
  const node = join(clone, '..', 'fake-node');
  writeFileSync(node, '#!/usr/bin/env bash\nexec bash "$@"\n');
  chmodSync(node, 0o755);
  return node;
}

/**
 * Runs the real _selective_worktree_reset with a real run_tsc_verification available to it, and
 * reports the globals it left behind.
 */
function runReset(clone: string, tscState: 'true' | 'false' | 'unknown', opts: { tscExit?: number } = {}) {
  const node = installTsc(clone, opts.tscExit ?? 0);
  const logDir = join(clone, '..', 'logs'); mkdirSync(logDir, { recursive: true });
  writeFileSync(join(clone, '..', 'prd.json'), JSON.stringify({
    stories: [{ id: 'AMSD-2041',
      fixSiteAnalysis: [{ file: 'src/contentstack.ts', fixVerified: true, helper: 'livePreview' }] }],
  }));
  const script = join(clone, '..', 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `PROJECT_ROOT=${JSON.stringify(clone)}`,
    `LOG_DIR=${JSON.stringify(logDir)}`,
    `NODE_CMD=${JSON.stringify(node)}`,
    'EPAM_BROWNFIELD=1',
    'JIRA_BASELINE_BRANCH=develop',
    'log() { echo "LOG:$*" >&2; }; warning() { echo "WARN:$*" >&2; }',
    'success() { echo "OK:$*" >&2; }; info() { :; }; error() { echo "ERR:$*" >&2; }',
    'is_truthy() { case "${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }',
    '_provision_epam_plugin_config() { :; }',
    // The rejection the deliverables gate already produced. It must survive: it is what the
    // next attempt is told, and a tsc run inside the reset would otherwise overwrite it.
    // The reset now asks the SPEC which files matter, so the fixture must carry one.
    `MAIN_PRD_FILE=${JSON.stringify(join(clone, '..', 'prd.json'))}`,
    'VERIFICATION_FAILURE="## Verification Failure|2 VERIFIED fix site(s) left unchanged"',
    `LAST_ATTEMPT_TSC_PASSED=${tscState}`,
    'LAST_VERIFIED_TOUCHED_FILES="src/contentstack.ts"',
    'LAST_VERIFIED_UNCHANGED_FILES=""',
    lift('run_tsc_verification'),
    lift('_selective_worktree_reset'),
    '_selective_worktree_reset "AMSD-2041"',
    'echo "TOUCHED=[$LAST_VERIFIED_TOUCHED_FILES]"',
    'echo "VF=[$VERIFICATION_FAILURE]"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  return { out: (r.stdout || '') + (r.stderr || '') };
}

/** The partial-but-correct work an incomplete story leaves on disk. */
function writePartialWork(clone: string) {
  writeFileSync(join(clone, 'src/contentstack.ts'),
    'export const original = 1;\nexport const livePreview = true;\n');
}

describe('the fixture is real — otherwise every assertion below is vacuous', () => {
  it('the partial work is genuinely a diff from baseline', () => {
    const { clone } = fixture();
    writePartialWork(clone);
    const status = execFileSync('git', ['-C', clone, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status).toMatch(/src\/contentstack\.ts/);
  });

  it('the reset really does destroy work that touched NO fix site', () => {
    // Redesigned 2026-08-10: the compiler no longer decides. Work on a file the spec never named
    // is still discarded — that is what keeps a failed attempt's noise out of the next attempt.
    const { clone } = fixture();
    writeFileSync(join(clone, 'src/noise.ts'), 'export const noise = 1;\n');
    runReset(clone, 'false');
    expect(existsSync(join(clone, 'src/noise.ts'))).toBe(false);
  });
});

describe('THE DEFECT: partial work on a VERIFIED fix site is preserved', () => {
  // Redesigned 2026-08-10. The keep/discard test used to be "does the whole tree compile?",
  // which is the INVERSE signal for a multi-file feature: a provider written before its
  // consumer is correct progress and a compile error. It could only preserve work that was
  // already coherent. It now asks the spec — did the attempt change a verified fix site?
  it('work that changed a verified fix site survives the reset', () => {
    const { clone } = fixture();
    writePartialWork(clone);
    runReset(clone, 'unknown', { tscExit: 2 });   // tsc irrelevant now
    expect(
      readFileSync(join(clone, 'src/contentstack.ts'), 'utf8'),
      'a change to a VERIFIED fix site was destroyed — 25 writes were lost this way',
    ).toContain('livePreview');
  });

  it('the carryover list survives with it, so the next attempt is told what is done', () => {
    const { clone } = fixture();
    writePartialWork(clone);
    const { out } = runReset(clone, 'unknown', { tscExit: 2 });
    expect(out).toContain('TOUCHED=[src/contentstack.ts]');
  });

  it('an attempt that touched NO fix site is still reset', () => {
    // Nothing of value was produced; resetting keeps the next attempt from inheriting noise.
    const { clone } = fixture();
    writeFileSync(join(clone, 'src', 'unrelated.ts'), 'export const noise = 1;\n');
    runReset(clone, 'unknown', { tscExit: 0 });
    expect(existsSync(join(clone, 'src/unrelated.ts'))).toBe(false);
  });

  it('a compile failure no longer decides it — the spec does', () => {
    const { clone } = fixture();
    writePartialWork(clone);
    runReset(clone, 'unknown', { tscExit: 2 });
    expect(
      readFileSync(join(clone, 'src/contentstack.ts'), 'utf8'),
      'the compiler is still gating preservation',
    ).toContain('livePreview');
  });

  it('does not clobber the rejection the writer is about to be shown', () => {
    const { clone } = fixture();
    writePartialWork(clone);
    const { out } = runReset(clone, 'unknown', { tscExit: 2 });
    expect(out).toContain('VF=[## Verification Failure|2 VERIFIED fix site(s) left unchanged]');
  });
});

describe('the retry loop records "never ran" distinctly from "ran and failed"', () => {
  /**
   * Executes the real assignment block from claude.sh against each combination, rather than
   * asserting the source text contains a branch — a branch can be present and unreachable.
   */
  function record(beforeTsc: 'true' | 'false', after: 'true' | 'false'): string {
    const i = SRC.indexOf('local _invoke_success_before_tsc="$invoke_success"');
    expect(i, 'the assignment block moved — this test is anchored to it').toBeGreaterThan(-1);
    const block = SRC.slice(SRC.indexOf('if [ "$_invoke_success_before_tsc"', i));
    const body = block.slice(0, block.indexOf('\n        fi') + 11);
    const r = spawnSync('bash', ['-c',
      `_invoke_success_before_tsc=${beforeTsc}\ninvoke_success=${after}\n${body}\n` +
      'printf "%s" "$LAST_ATTEMPT_TSC_PASSED"'], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  }

  it('tsc ran and passed -> true', () => {
    expect(record('true', 'true')).toBe('true');
  });

  it('tsc ran and failed -> false', () => {
    expect(record('true', 'false')).toBe('false');
  });

  it('THE DEFECT: an earlier gate rejected first, so tsc never ran -> unknown, not false', () => {
    expect(
      record('false', 'false'),
      'recording "false" here is what convicts correct work of being broken',
    ).toBe('unknown');
  });

  it('the per-story initialiser starts at unknown — a story that never ran tsc proved nothing', () => {
    // implement_story resets these globals so one story does not inherit the previous story's
    // verdict. Initialising to `false` states, falsely, that this story's tree failed a check.
    // Anchored on implement_story's own reset block — _selective_worktree_reset clears the same
    // two globals, and matching that one instead would assert nothing about initialisation.
    const i = SRC.indexOf('same pattern as STORY_REJECTION_KEY');
    expect(i, 'the per-story reset block moved — re-anchor this test').toBeGreaterThan(-1);
    const init = SRC.slice(i, i + 700);
    expect(init).toMatch(/LAST_ATTEMPT_TSC_PASSED=unknown/);
  });
});
