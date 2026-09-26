/**
 * A BASELINE THAT FOUND NOTHING IS NOT A CLEAN BASELINE.
 *
 * The baseline is the set of tests already failing at the phase's starting commit; the whole-suite
 * check subtracts it so a story is blamed only for what it broke. It is built by checking that
 * commit into a worktree, running the suite there, and caching the parsed failures.
 *
 * When that run produces NO parseable failures, the cache is written EMPTY — and an empty cache
 * reads as "nothing was failing", which is the most dangerous possible value: every pre-existing
 * failure is then charged to whichever story ran last.
 *
 * Live, regintel 2026-09-22/23: ten baseline caches, all 0 bytes, written while the declared test
 * command was bare `pytest` — which exited 2 having collected nothing, so there were no FAILED
 * lines to parse. The codeline had five real failures the whole time. REGI-002 was handed the
 * RU-006 defect twice, fixed it correctly twice, and was judged non-converged twice because it
 * could not also fix four tests owned by other stories.
 *
 * Proven by reproduction on a copy of that codeline: with the corrected command the same builder
 * caches five ids and returns "no new failures". The command is fixed (10a83f7a); this closes the
 * fail-open that let the emptiness pass for weeks — a run that finds nothing must say it could not
 * judge, never that everything was fine.
 *
 * Executes the REAL builder against real git repositories.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const GATE = join(ROOT, 'orchestrations/scripts/lib/tsc-baseline-gate.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A codeline whose declared test command behaves as `opts.baselineRuns` dictates:
 *  - 'fails'   : exits non-zero and prints real FAILED lines (a usable baseline)
 *  - 'cannot'  : exits non-zero and prints nothing parseable (the bare-pytest shape)
 */
function build(opts: { baselineRuns: 'fails' | 'cannot' }) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-honest-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam'), { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

  // the declared command: a script in the repo, so the worktree carries it too
  const cmd = opts.baselineRuns === 'fails'
    ? `printf 'FAILED tests/test_a.py::test_one - AssertionError\\nFAILED tests/test_b.py::test_two - AssertionError\\n2 failed\\n'; exit 1`
    : `printf 'ImportError while loading conftest\\nE   ModuleNotFoundError: No module named app\\n' >&2; exit 2`;
  writeFileSync(join(repo, 'run-tests.sh'), `#!/usr/bin/env bash\n${cmd}\n`);
  spawnSync('chmod', ['+x', join(repo, 'run-tests.sh')]);
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({
    test: {
      command: './run-tests.sh',
      failurePattern: '^(?:FAILED|ERROR)\\s+(\\S+?)::(\\S+?)(?:\\s+-\\s|\\s*$)',
      failureIdentity: '{1}::{2}',
    },
  }, null, 2));
  writeFileSync(join(repo, 'app.py'), 'x = 1\n');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'baseline');
  const baselineSha = git('rev-parse', 'HEAD').stdout.trim();

  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha + '\n');

  // what the CURRENT run's suite reported — two failures, the same ones the baseline has
  const current = join(dir, 'current.txt');
  writeFileSync(current, 'FAILED tests/test_a.py::test_one - AssertionError\nFAILED tests/test_b.py::test_two - AssertionError\n2 failed\n');

  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export LOG_DIR=${JSON.stringify(logDir)}`,
    `export AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}`,
    `export NODE_BIN=${JSON.stringify(process.execPath)}`,
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    shellFunction(GATE, '_bg_vendor_dirs'),
    shellFunction(GATE, '_run_project_verification'),
    shellFunction(GATE, 'baseline_new_failures'),
    `EPAM_BROWNFIELD=1 baseline_new_failures "$PROJECT_ROOT" "$NODE_BIN" "$LOG_DIR" test ${JSON.stringify(current)}; echo "RC=$?"`, // the baseline subtracts pre-existing failures in BROWNFIELD only (greenfield judges the whole check)
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const cache = join(logDir, `baseline-failures-test-${baselineSha.slice(0, 12)}.txt`);
  return {
    out,
    rc: Number((out.match(/RC=(\d+)/) || [])[1]),
    cacheExists: existsSync(cache),
    cacheBytes: existsSync(cache) ? readFileSync(cache, 'utf8').trim().length : -1,
  };
}

describe('a baseline that found nothing is not a clean baseline', () => {
  it('a baseline that RAN subtracts its failures — the story is not blamed', () => {
    const r = build({ baselineRuns: 'fails' });
    expect(r.cacheBytes, `the baseline cached nothing though its run reported failures:\n${r.out.slice(-400)}`).toBeGreaterThan(0);
    expect(r.rc, 'pre-existing failures were charged to the story').toBe(0);
  });

  it('REPRODUCES the live fossil: a baseline that could not run must NOT be cached as clean', () => {
    const r = build({ baselineRuns: 'cannot' });
    expect(r.cacheBytes, 'an empty cache was written, which reads as "nothing was failing"').not.toBe(0);
  });

  it('and says so, rather than reporting a clean baseline', () => {
    const r = build({ baselineRuns: 'cannot' });
    expect(r.out, 'the run was told nothing about an unusable baseline').toMatch(/CANNOT BUILD|could not|unusable|not a pass/i);
  });
});

/** The same builder, but with NO phase-baseline-sha.txt — the baseline was never declared. */
function buildWithoutBaselineSha() {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-undeclared-'));
  dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({
    test: { command: 'true', failurePattern: '^(?:FAILED)\\s+(\\S+?)::(\\S+?)(?:\\s+-\\s|\\s*$)', failureIdentity: '{1}::{2}' },
  }));
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  writeFileSync(join(repo, 'app.py'), 'x = 1\n');
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'baseline');
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const current = join(dir, 'current.txt');
  writeFileSync(current, 'FAILED tests/test_a.py::test_one - AssertionError\n1 failed\n');
  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `export PROJECT_ROOT=${JSON.stringify(repo)}`,
    `export LOG_DIR=${JSON.stringify(logDir)}`,
    `export AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}`,
    `export NODE_BIN=${JSON.stringify(process.execPath)}`,
    'log() { echo "LOG: $*"; }; warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }',
    'success() { echo "OK: $*"; }; info() { :; }',
    shellFunction(GATE, '_bg_vendor_dirs'),
    shellFunction(GATE, '_run_project_verification'),
    shellFunction(GATE, 'baseline_new_failures'),
    `EPAM_BROWNFIELD=1 baseline_new_failures "$PROJECT_ROOT" "$NODE_BIN" "$LOG_DIR" test ${JSON.stringify(current)}; echo "RC=$?"`, // the baseline subtracts pre-existing failures in BROWNFIELD only (greenfield judges the whole check)
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, rc: Number((out.match(/RC=(\d+)/) || [])[1]) };
}

/**
 * A BASELINE THAT WAS NEVER DECLARED IS NOT A CLEAN BASELINE EITHER.
 *
 * Without phase-baseline-sha.txt the builder never runs, `new_errors` keeps the whole current
 * output, and every pre-existing failure is charged to the story — silently, nothing logged.
 * Found 2026-09-23: the one-story harness copies the install with an EMPTY logs directory, so no
 * baseline files appeared and no diagnostics were printed, while each story was blamed for the
 * five failures it inherited. A real run whose baseline SHA went missing would be told as little.
 */
describe('a baseline that was never declared is not a clean baseline either', () => {
  it('says so, instead of blaming the story in silence', () => {
    const r = buildWithoutBaselineSha();
    expect(r.out, 'the run was told nothing, and the story was charged for failures it inherited')
      .toMatch(/baseline/i);
    expect(r.out).toMatch(/not a pass|cannot|could not|no .*declared/i);
  });

  it('does not report the inherited failures as the story\'s own', () => {
    const r = buildWithoutBaselineSha();
    expect(r.rc, 'a missing baseline read as "the story broke all of this"').not.toBe(0);
  });
});
