/**
 * Our own tooling config must never be committed into a client repo.
 *
 * Found in the metrolinx commit e60b7bb, then REPRODUCED by mock1 (d3df3f9):
 * the story-completion commit contained .epam/contract-generation.json,
 * .epam/dependency-check.json and .epam/known-fixes.json alongside the actual
 * one-line fix. Those are epam-cli's own dependency-check/contract manifests. A
 * client repo must never carry them — a standing rule, and separately they bury
 * the real deliverable in noise.
 *
 * commit_completed_story() already stages with a pathspec exclusion list
 * (orchestrations/logs, node_modules, build, .next). .epam was simply missing
 * from it, so `git add -A` swept it in.
 *
 * NOT excluded here: package-lock.json. mock1 committed 1831 lines of it, which is
 * noise — but package.json changed in the same commit, so the lockfile is arguably
 * a legitimate part of that change, and dropping a lockfile while its manifest
 * moves would break reproducible installs. Excluding it needs a deliberate
 * decision about dependency changes, not a quiet pathspec.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// commit_completed_story() moved to lib/git-ops.sh (2026-08-02 git-ops
// consolidation) — single source of truth shared by claude.sh,
// codemie-claude.sh, and run-agent-orchestration.sh.
const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Extract the staging pathspec from commit_completed_story and run it for real. */
function stageInSandbox() {
  const repo = mkdtempSync(join(tmpdir(), 'commit-excl-')); dirs.push(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 't@t.com');
  git('config', 'user.name', 'T');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'hello.ts'), 'export const x = 1;\n');
  git('add', '-A'); git('commit', '-m', 'baseline', '--quiet');

  // The real deliverable, plus the tooling config that should never be committed.
  writeFileSync(join(repo, 'src', 'hello.ts'), 'export const x = 2;\n');
  // Every tool artifact epam-cli drops into a client repo — the CLASS, not one
  // instance. Excluding only .epam let .deepeval into a live commit hours later.
  for (const [dir, file] of [
    ['.epam', 'dependency-check.json'],
    ['.deepeval', '.deepeval_telemetry.txt'],
    ['.codegraph', 'index.json'],
    ['.contracts', 'generated.json'],
    // Real leak, 2026-08-01 (Writer Retest dry run): orchestrations/agents/KB.md
    // reached a live metrolinx codeline. Only orchestrations/logs/* had been
    // excluded — the KB-scratchpad writer uses a different subpath.
    ['orchestrations/agents', 'KB.md'],
  ]) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, file), '{}\n');
  }

  // EXECUTE the real staging helper rather than scraping its pathspec out of the source.
  // The list moved into git_add_client_outputs (lib/git-ops.sh) when the three drifting
  // copies were consolidated, and a regex anchored on the old inline `git add -A --` form
  // silently found nothing — which fails the suite at COLLECTION time, not as an
  // assertion, so it does not appear in a "×" filter of the run output.
  const runner = join(mkdtempSync(join(tmpdir(), 'stage-')), 'run.sh');
  writeFileSync(
    runner,
    [
      'set -uo pipefail',
      'log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }',
      `source ${JSON.stringify(CLAUDE_SH)}`,
      `git_add_client_outputs ${JSON.stringify(repo)}`,
    ].join('\n'),
  );
  execFileSync('bash', [runner], { encoding: 'utf8' });
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

describe('the pathspec fallback cannot reintroduce it', () => {
  it('unstages .epam unconditionally, whichever add path ran', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    // The fallback `git add -A` carries no pathspec, so exclusion alone is not
    // enough — a failure of the pathspec form would put .epam straight back.
    // The dir names now come from _ENGINE_OWNED_DIRS (lib/engine-paths.sh), one shared
    // definition, so assert the unstage runs over that list rather than re-listing them.
    expect(src, 'no unconditional unstage — the no-pathspec fallback reintroduces them')
      .toMatch(/reset -q -- "\$\{_resets\[@\]\}"/);
    const engineDirs = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/lib/engine-paths.sh'), 'utf8');
    for (const d of ['orchestrations', '.epam', '.deepeval', '.codegraph', '.contracts']) {
      expect(engineDirs, `${d} missing from the shared engine-owned list`).toContain(`'${d}'`);
    }
  });
});

describe('story commit excludes our own tooling config', () => {
  const staged = stageInSandbox();

  it('stages the actual deliverable', () => {
    expect(staged).toContain('src/hello.ts');
  });

  it('does NOT stage ANY tool artifact — epam-cli output must not enter a client repo', () => {
    const leaked = staged.filter(f => /^(\.(epam|deepeval|codegraph|contracts)|orchestrations)\//.test(f));
    expect(leaked,
      'our dependency-check/contract manifests were committed into the client repo, ' +
      'burying the real fix and violating the no-client-repo-writes rule')
      .toEqual([]);
  });
});

describe('the optional phase assessment has room for a reasoning model', () => {
  it('allows more than 120s per attempt', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    const m = src.match(/PHASE_ASSESSMENT_TIMEOUT_SECS:-(\d+)/);
    expect(m, 'the assessment timeout default vanished').toBeTruthy();
    // 120 timed out twice live: these models spend <think> tokens against a
    // 32768-token budget before emitting anything.
    expect(Number(m![1])).toBeGreaterThanOrEqual(300);
    // But the cap must still bound an OPTIONAL step: 2 attempts must stay under
    // the 600s-per-attempt default it was introduced to protect against.
    expect(Number(m![1]), 'the cap no longer bounds an optional step').toBeLessThan(600);
  });
});
