/**
 * THE MANIFEST IS WHAT EVERY GATE REVIEWS. IT WAS NOT ACCURATE.
 *
 * lib/story-outputs.sh exists so reviewers are HANDED what the run produced instead of
 * rediscovering scope by linting the whole tree. Live metrolinx 20260804T225443Z showed it
 * wrong in both directions at once:
 *
 *   OVER-INCLUSIVE   upexpress listed `orchestrations/agents/KB.md` — an ENGINE file that
 *                    does not exist in that client repo.
 *   UNDER-INCLUSIVE  upexpress did NOT list ContentstackLink.tsx, yet the reviewer cited
 *                    it at line 23 and reasoned about it from the diff it was given.
 *   DELETIONS LOST   the reviewer reported the writer had deleted a 179-line test file
 *                    with 10 tests. No deletion appears in any manifest.
 *
 * Three causes, all in this file:
 *
 *  1. THE UNION NEVER SHRINKS. `{ cat manifest; printf produced; } | sort -u` only ever
 *     adds. A file the writer reverted, or one recorded when a different root was passed,
 *     stays listed forever — and there is no provenance, so you cannot tell WHEN it
 *     entered. The union is also unnecessary: the diff is taken against the PHASE
 *     BASELINE, so it already covers everything committed since, including the
 *     repro-test-writer's later commit. That is the late-producer problem the union was
 *     written to solve.
 *
 *  2. ANY DIRECTORY WITH A .git WAS ACCEPTED as the lane's repo, and the ref fell back to
 *     `origin/<baseline>` when the SHA file was missing. That fallback is the silent
 *     wrong-scope shape this file's own header complains about. A lane's baseline SHA
 *     resolves ONLY in that lane's repo (verified against all three live lanes), so
 *     requiring it makes git's object database the identity oracle.
 *
 *  3. DELETED PATHS WERE RECORDED AS OUTPUTS, so story_outputs_tests could hand a
 *     reviewer a test file that no longer exists — while the fact that test coverage went
 *     DOWN, which a gate genuinely needs, was invisible.
 *
 * Executes the REAL functions against REAL repos.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const STORY_OUTPUTS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-outputs.sh');
const PRE_RUN_RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'manifest-'));
  const repo = join(root, 'client');
  const logDir = join(root, 'logs');
  mkdirSync(repo, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  git(root, 'init', '--quiet', '-b', 'develop', 'client');
  git(repo, 'config', 'user.email', 't@e.com');
  git(repo, 'config', 'user.name', 'T');

  const put = (p: string, c = 'x\n') => {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  };
  put('src/keep.ts');
  put('src/legacy.spec.ts', 'describe("old", () => {});\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'baseline');
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
  return { root, repo, logDir, put };
}

/** Run a REAL story-outputs function and return its lines. */
function call(fn: string, repo: string, logDir: string, phase = 'core') {
  const script = join(mkdtempSync(join(tmpdir(), 'so-')), 'run.sh');
  writeFileSync(
    script,
    [
      'set -uo pipefail',
      'log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }',
      `PHASE=${JSON.stringify(phase)}`,
      `source ${JSON.stringify(STORY_OUTPUTS)}`,
      `${fn} ${JSON.stringify(repo)} ${JSON.stringify(logDir)}`,
      'echo "RC=$?"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  const out = r.stdout || '';
  return {
    lines: out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('RC=')),
    rc: Number(/RC=(\d+)/.exec(out)?.[1] ?? -1),
    err: r.stderr || '',
  };
}

const manifestOf = (logDir: string) => {
  const p = join(logDir, 'story-outputs-core.txt');
  return existsSync(p)
    ? readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : null;
};

describe('the manifest equals git truth, not an accumulation', () => {
  it('THE STALE ENTRY: a file the writer reverted disappears on the next record', () => {
    const f = fixture();
    f.put('src/added.ts');
    call('story_outputs_record', f.repo, f.logDir);
    expect(manifestOf(f.logDir)).toContain('src/added.ts');

    // The writer backs the change out — Step 9's unstage, a self-heal revert, whatever.
    rmSync(join(f.repo, 'src/added.ts'));
    call('story_outputs_record', f.repo, f.logDir);
    expect(
      manifestOf(f.logDir),
      'the union only ever added, so a reverted file stayed listed as writer output ' +
        'forever and every gate reviewed a file that is not in the tree',
    ).not.toContain('src/added.ts');
  });

  it('recording twice is idempotent, not cumulative', () => {
    const f = fixture();
    f.put('src/one.ts');
    call('story_outputs_record', f.repo, f.logDir);
    const first = manifestOf(f.logDir);
    call('story_outputs_record', f.repo, f.logDir);
    expect(manifestOf(f.logDir)).toEqual(first);
  });

  it('a LATE producer is still captured — the reason the union existed', () => {
    const f = fixture();
    f.put('src/impl.ts');
    call('story_outputs_record', f.repo, f.logDir);
    // The repro-test-writer commits its spec AFTER the story loop recorded.
    f.put('src/impl.spec.ts');
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '--quiet', '-m', 'AMSD-1: add test');
    call('story_outputs_record', f.repo, f.logDir);
    expect(
      manifestOf(f.logDir),
      'the diff is taken against the PHASE BASELINE, so committed work since the baseline ' +
        'is included without needing to union with the previous manifest',
    ).toEqual(expect.arrayContaining(['src/impl.ts', 'src/impl.spec.ts']));
  });
});

describe('engine files never enter a client manifest', () => {
  it('an engine artefact present in the tree is not writer output', () => {
    const f = fixture();
    f.put('src/real.ts');
    f.put('orchestrations/agents/KB.md', '# KB\n');
    f.put('.epam/settings.json', '{}\n');
    call('story_outputs_record', f.repo, f.logDir);
    const m = manifestOf(f.logDir) ?? [];
    expect(m).toContain('src/real.ts');
    expect(
      m,
      'upexpress listed orchestrations/agents/KB.md as writer output on run 20260804T225443Z',
    ).not.toContain('orchestrations/agents/KB.md');
    expect(m).not.toContain('.epam/settings.json');
  });
});

describe('the baseline SHA is the lane identity — no silent fallback', () => {
  it('records NOTHING when the baseline SHA file is missing', () => {
    const f = fixture();
    rmSync(join(f.logDir, 'phase-baseline-sha.txt'));
    f.put('src/x.ts');
    call('story_outputs_record', f.repo, f.logDir);
    expect(
      manifestOf(f.logDir),
      'falling back to origin/<baseline> lets a DIFFERENT repo satisfy the ref, which is ' +
        'how an engine-repo diff can be written into a client lane manifest. An ABSENT ' +
        'manifest means "fall back and say so"; a wrong one is silent.',
    ).toBeNull();
  });

  it('records nothing when the baseline SHA does not resolve in THIS repo', () => {
    const f = fixture();
    writeFileSync(join(f.logDir, 'phase-baseline-sha.txt'), `${'0'.repeat(40)}\n`);
    f.put('src/x.ts');
    call('story_outputs_record', f.repo, f.logDir);
    expect(manifestOf(f.logDir)).toBeNull();
  });
});

describe('deletions are reported, not silently dropped or mislabelled as outputs', () => {
  it('a deleted file is NOT listed as a produced file', () => {
    const f = fixture();
    rmSync(join(f.repo, 'src/legacy.spec.ts'));
    f.put('src/new.ts');
    call('story_outputs_record', f.repo, f.logDir);
    expect(
      manifestOf(f.logDir),
      'a deleted path handed to a reviewer as "writer output" points at a file that is ' +
        'not there — story_outputs_tests would nominate a test that cannot run',
    ).not.toContain('src/legacy.spec.ts');
  });

  it('but the deletion IS visible — the writer deleting 10 tests must not be invisible', () => {
    const f = fixture();
    rmSync(join(f.repo, 'src/legacy.spec.ts'));
    call('story_outputs_record', f.repo, f.logDir);
    const deleted = call('story_outputs_deleted', f.repo, f.logDir);
    expect(deleted.rc).toBe(0);
    expect(
      deleted.lines,
      'the reviewer caught a 179-line test file deleted with no replacement; the gates ' +
        'had no way to see that from the manifest',
    ).toContain('src/legacy.spec.ts');
  });

  it('story_outputs_tests nominates only tests that exist', () => {
    const f = fixture();
    rmSync(join(f.repo, 'src/legacy.spec.ts'));
    f.put('src/fresh.spec.ts');
    call('story_outputs_record', f.repo, f.logDir);
    const tests = call('story_outputs_tests', f.repo, f.logDir);
    expect(tests.lines).toContain('src/fresh.spec.ts');
    expect(tests.lines).not.toContain('src/legacy.spec.ts');
  });
});

describe('the manifest is wiped for every run, in every lane', () => {
  // pre-run-reset.sh swept story-outputs-*.txt with `find "$LOG_DIR" -maxdepth 1`.
  // Lane manifests live at $LOG_DIR/lanes/<lane>/story-outputs-<phase>.txt — depth 3 —
  // so they were NEVER wiped and accumulated across runs.
  const src = readFileSync(PRE_RUN_RESET, 'utf8');

  it('the sweep reaches lane manifests, not just the top level', () => {
    const sweep = src
      .split('\n')
      .find((l) => l.includes('story-outputs-') && l.includes('find'));
    expect(sweep, 'the story-outputs sweep line moved').toBeTruthy();
    expect(
      sweep,
      'maxdepth 1 stops at $LOG_DIR; every lane manifest lives under lanes/<lane>/ and ' +
        'survived every run, unioning with the next run forever',
    ).not.toMatch(/-maxdepth\s+1\b/);
  });
});
