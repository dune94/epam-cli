/**
 * ensure_story_branch() — run-agent-orchestration.sh
 *
 * Live bug this eliminates (2026-07-22): committing directly onto the shared
 * baseline branch (develop) relied on a durable local marker to know what
 * "last known good" state to reset back to before each run. That marker only
 * updates when a story passes story_tsc_gate — a manual correction to the
 * branch doesn't update it, so it can point at an already-discarded, orphaned
 * commit. Confirmed live: a rejected commit got silently reintroduced this
 * way, and a real story commit landed on top of the wrong base.
 *
 * Fix: every story commits to its own branch ("AI-<story_id>"), freshly
 * created off origin/<baseline_branch> every time via `checkout -B` — no
 * shared branch state to protect, no marker to go stale.
 *
 * Real git repos throughout (a fake bare "origin" + a working clone) — no
 * mocking of git itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
// ensure_story_branch() itself now lives in lib/git-ops.sh (2026-08-02 git-ops
// consolidation — single source of truth shared by claude.sh, codemie-claude.sh,
// and run-agent-orchestration.sh); the wiring check below still reads
// ORCH_SCRIPT to confirm the CALL SITE.
const GIT_OPS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extractGitOpsFn(name: string): string {
  const src = require('node:fs').readFileSync(GIT_OPS_SH, 'utf8');
  const start = src.indexOf(`${name}() {`);
  const end = src.indexOf('\n}', start) + 2;
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, end);
}

// ensure_story_branch() calls _provision_epam_plugin_config() (2026-08-02) —
// both must be present for a standalone run.
function extractFn(): string {
  return [extractGitOpsFn('_provision_epam_plugin_config'), extractGitOpsFn('ensure_story_branch')].join('\n');
}

const LOG_STUBS = `
warning() { echo "WARN: $*" >&2; }
success() { echo "OK: $*"; }
`;

/** A bare "origin" repo + one working clone, mimicking a real brownfield codeline. */
function makeFixture(): { bareOrigin: string; clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'story-branch-fixture-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=develop', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=develop'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  writeFileSync(join(seed, 'file.txt'), 'v1\n');
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'develop', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

  return { bareOrigin, clone };
}

function runFn(
  codelineRoot: string,
  storyId: string,
  baselineBranch = 'develop',
  branchPrefix?: string,
): { stdout: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-story-branch-run-'));
  try {
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      LOG_STUBS,
      extractFn(),
      `ensure_story_branch "${codelineRoot}" "${storyId}" "${baselineBranch}"`,
      'echo "EXIT_MARKER:$?"',
    ].join('\n'));
    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EPAM_BROWNFIELD: '1',
        ...(branchPrefix !== undefined ? { EPAM_BRANCH_PREFIX: branchPrefix } : {}),
      },
      timeout: 30000,
    });
    const combined = (result.stdout || '') + (result.stderr || '');
    const m = combined.match(/EXIT_MARKER:(\d+)/);
    return { stdout: combined, exitCode: m ? parseInt(m[1], 10) : (result.status ?? -1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function currentBranch(repo: string): string {
  return execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
}

function sha(repo: string, ref = 'HEAD'): string {
  return execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('ensure_story_branch — real git repos, no mocking', () => {
  it('derives the branch name from the story ID passed in — never a hardcoded literal', () => {
    const { clone } = makeFixture();
    const { exitCode } = runFn(clone, 'ANY-GENERIC-STORY-ID-999');
    expect(exitCode).toBe(0);
    expect(currentBranch(clone)).toBe('AI-ANY-GENERIC-STORY-ID-999');
  });

  it('creates the branch fresh off origin/<baseline branch>, matching its current tip exactly', () => {
    const { clone, bareOrigin } = makeFixture();
    runFn(clone, 'STORY-A');
    const originTip = execFileSync('git', ['rev-parse', 'develop'], { cwd: bareOrigin, encoding: 'utf8' }).trim();
    expect(sha(clone)).toBe(originTip);
  });

  it('resets an existing same-named branch to the fresh remote tip, discarding any prior local commits on it (clean slate every run)', () => {
    const { clone, bareOrigin } = makeFixture();
    runFn(clone, 'STORY-B');
    // Simulate a killed/abandoned prior attempt: commit garbage onto the story branch.
    writeFileSync(join(clone, 'garbage.txt'), 'leftover from a killed run\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'abandoned WIP', '--quiet'], { cwd: clone });
    expect(existsSync(join(clone, 'garbage.txt'))).toBe(true);

    // Re-run for the SAME story — must discard the garbage commit entirely.
    const { exitCode } = runFn(clone, 'STORY-B');
    expect(exitCode).toBe(0);
    expect(currentBranch(clone)).toBe('AI-STORY-B');
    expect(existsSync(join(clone, 'garbage.txt'))).toBe(false);
    const originTip = execFileSync('git', ['rev-parse', 'develop'], { cwd: bareOrigin, encoding: 'utf8' }).trim();
    expect(sha(clone)).toBe(originTip);
  });

  it('REPRODUCES the live incident and confirms the fix: dirty MODIFICATIONS to a tracked file (identical between old and new branch tip, so checkout -B alone leaves them untouched) are discarded by the working-tree hard reset', () => {
    const { clone } = makeFixture();
    runFn(clone, 'STORY-DIRTY-TRACKED');
    // Modify a tracked file WITHOUT committing — exactly the leftover state
    // from a killed/interrupted prior attempt (confirmed live, 2026-08-02,
    // metrolinx AMSD-2041: a modified-but-uncommitted contentstack.ts
    // survived an earlier ensure_story_branch call intact).
    writeFileSync(join(clone, 'file.txt'), 'dirty uncommitted edit\n');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf8' }).trim()).not.toBe('');

    const { exitCode } = runFn(clone, 'STORY-DIRTY-TRACKED');
    expect(exitCode).toBe(0);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf8' }).trim()).toBe('');
    expect(readFileSync(join(clone, 'file.txt'), 'utf8')).toBe('v1\n');
  });

  it('REPRODUCES the live incident and confirms the fix: untracked stray files (leftover from a killed prior attempt) are removed by the working-tree clean', () => {
    const { clone } = makeFixture();
    runFn(clone, 'STORY-DIRTY-UNTRACKED');
    writeFileSync(join(clone, 'stray-leftover.ts'), 'never committed, never should have been there\n');

    const { exitCode } = runFn(clone, 'STORY-DIRTY-UNTRACKED');
    expect(exitCode).toBe(0);
    expect(existsSync(join(clone, 'stray-leftover.ts'))).toBe(false);
  });

  it('re-provisions .epam/settings.json and .epam/codeline-facts.json (wiped by the working-tree clean) from the project config', () => {
    const { clone } = makeFixture();
    const configDir = mkdtempSync(join(tmpdir(), 'ensure-story-branch-cfg-'));
    cleanupDirs.push(configDir);
    writeFileSync(join(configDir, 'plugins.json'), JSON.stringify({ tools: ['/abs/plugin.js'] }));
    writeFileSync(join(configDir, 'codeline-facts.json'), JSON.stringify({ mycl: { facts: ['fact-a'] } }));
    const prdPath = join(configDir, 'prd.json');
    writeFileSync(
      prdPath,
      JSON.stringify({ project: { outputDirs: [{ codeline: 'mycl', path: clone }] } }),
    );

    // Leave stray junk in .epam/ from a "prior attempt" — must be wiped and
    // replaced with the real config, not left as-is.
    mkdirSync(join(clone, '.epam'), { recursive: true });
    writeFileSync(join(clone, '.epam/settings.json'), JSON.stringify({ tools: ['/stale/junk.js'] }));

    const dir = mkdtempSync(join(tmpdir(), 'ensure-story-branch-run-'));
    try {
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, [
        '#!/usr/bin/env bash',
        LOG_STUBS,
        `EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(configDir)}`,
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        extractFn(),
        `ensure_story_branch "${clone}" "STORY-PROVISION" "develop"`,
        'echo "EXIT_MARKER:$?"',
      ].join('\n'));
      const result = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_BROWNFIELD: '1' },
        timeout: 30000,
      });
      expect((result.stdout || '') + (result.stderr || '')).toMatch(/EXIT_MARKER:0/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const settings = JSON.parse(readFileSync(join(clone, '.epam/settings.json'), 'utf8'));
    expect(settings).toEqual({ tools: ['/abs/plugin.js'] });
    const facts = JSON.parse(readFileSync(join(clone, '.epam/codeline-facts.json'), 'utf8'));
    expect(facts).toEqual({ facts: ['fact-a'] });
  });

  it('reproduces and fixes the exact live bug: a stale/orphaned local commit never affects the new story branch, because the base always comes live from origin, not a cached SHA', () => {
    const { clone, bareOrigin } = makeFixture();
    // Simulate exactly what happened live: an orphaned commit sitting in
    // local history (e.g. from a previously-discarded manual reset), NOT
    // reachable from origin/develop, and NOT referenced by ensure_story_branch
    // at all — unlike the old marker-based design, which would have trusted
    // a stale pointer to this exact kind of commit.
    execFileSync('git', ['checkout', '-b', 'orphaned-old-attempt', '--quiet'], { cwd: clone });
    writeFileSync(join(clone, 'rejected-tooling.txt'), 'stuff that should never come back\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['commit', '-m', 'chore: rejected tooling (orphaned)', '--quiet'], { cwd: clone });
    const orphanedSha = sha(clone);
    execFileSync('git', ['checkout', 'develop', '--quiet'], { cwd: clone });

    const { exitCode } = runFn(clone, 'STORY-C');
    expect(exitCode).toBe(0);
    expect(currentBranch(clone)).toBe('AI-STORY-C');
    expect(sha(clone)).not.toBe(orphanedSha);
    const originTip = execFileSync('git', ['rev-parse', 'develop'], { cwd: bareOrigin, encoding: 'utf8' }).trim();
    expect(sha(clone)).toBe(originTip);
    expect(existsSync(join(clone, 'rejected-tooling.txt'))).toBe(false);
  });

  it('is a no-op (exit 0) when not in brownfield mode', () => {
    const { clone } = makeFixture();
    const dir = mkdtempSync(join(tmpdir(), 'ensure-story-branch-nonbf-'));
    try {
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, [
        '#!/usr/bin/env bash',
        LOG_STUBS,
        extractFn(),
        `ensure_story_branch "${clone}" "STORY-D" "develop"`,
        'echo "EXIT_MARKER:$?"',
      ].join('\n'));
      const result = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_BROWNFIELD: '0' },
        timeout: 30000,
      });
      const combined = (result.stdout || '') + (result.stderr || '');
      expect(combined).toMatch(/EXIT_MARKER:0/);
      expect(currentBranch(clone)).toBe('develop'); // untouched — not brownfield, no-op
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a safe no-op when codeline_root is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensure-story-branch-notgit-'));
    try {
      const { exitCode } = runFn(dir, 'STORY-E');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a safe no-op when no story_id is given', () => {
    const { clone } = makeFixture();
    const before = currentBranch(clone);
    const { exitCode } = runFn(clone, '');
    expect(exitCode).toBe(0);
    expect(currentBranch(clone)).toBe(before);
  });

  it('run 10x in a row with 10 different story IDs — each gets its own correctly-named, correctly-based branch, deterministically', () => {
    const { clone, bareOrigin } = makeFixture();
    const RUNS = 10;
    const originTip = execFileSync('git', ['rev-parse', 'develop'], { cwd: bareOrigin, encoding: 'utf8' }).trim();
    const outcomes: { exitCode: number; branch: string; matchesOrigin: boolean }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const storyId = `LOOP-STORY-${i}`;
      const { exitCode } = runFn(clone, storyId);
      outcomes.push({
        exitCode,
        branch: currentBranch(clone),
        matchesOrigin: sha(clone) === originTip,
      });
    }
    const failures = outcomes.filter((o, i) =>
      o.exitCode !== 0 || o.branch !== `AI-LOOP-STORY-${i}` || !o.matchesOrigin
    );
    expect(failures, `${failures.length}/${RUNS} failed: ${JSON.stringify(outcomes)}`).toHaveLength(0);
  }, 60000);

  it('defaults to plain "AI-<story_id>" when EPAM_BRANCH_PREFIX is unset (no hardcoded client convention)', () => {
    const { clone } = makeFixture();
    const { exitCode } = runFn(clone, 'STORY-NOPREFIX');
    expect(exitCode).toBe(0);
    expect(currentBranch(clone)).toBe('AI-STORY-NOPREFIX');
  });

  it('prepends EPAM_BRANCH_PREFIX when a project config sets it (e.g. a client husky hook requiring bugfix/ etc.)', () => {
    const { clone } = makeFixture();
    const { exitCode } = runFn(clone, 'STORY-PREFIXED', 'develop', 'bugfix/');
    expect(exitCode).toBe(0);
    expect(currentBranch(clone)).toBe('bugfix/AI-STORY-PREFIXED');
  });
});

describe('run-agent-orchestration.sh — story loop wiring', () => {
  const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');

  it('calls ensure_story_branch inside _run_one_main_story, with the live $story variable — not a hardcoded story name', () => {
    const fnStart = src.indexOf('_run_one_main_story() {');
    const fnEnd = src.indexOf('\nresolve_prompt_provider', fnStart);
    const fnBody = src.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 8000);
    expect(fnBody).toMatch(/ensure_story_branch\s+"\$\{PROJECT_ROOT:-\}"\s+"\$story"/);
  });

  it('calls ensure_story_branch AFTER the TC-writer gate and BEFORE the story actually starts running', () => {
    const fnStart = src.indexOf('_run_one_main_story() {');
    const tcGateIdx = src.indexOf('run_inline_tc_writer_gate', fnStart);
    const branchIdx = src.indexOf('ensure_story_branch "${PROJECT_ROOT:-}"', fnStart);
    const runningIdx = src.indexOf('log "  Running: $story"', fnStart);
    expect(tcGateIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(tcGateIdx);
    expect(runningIdx).toBeGreaterThan(branchIdx);
  });
});
