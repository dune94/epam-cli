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
    `baseline_new_failures "$PROJECT_ROOT" "$NODE_BIN" "$LOG_DIR" test ${JSON.stringify(current)}; echo "RC=$?"`,
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
