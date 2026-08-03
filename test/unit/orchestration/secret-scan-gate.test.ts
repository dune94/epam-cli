/**
 * Flow-gap analysis finding #2 (2026-07-12): no commit site in this pipeline
 * (Step 1.5 auto-commit in run-agent-orchestration.sh, commit_completed_story()
 * in claude.sh) scanned for accidentally-committed credentials before this.
 * SAST (Step 4.2) is the first thing that even looks at code content for
 * this — an LLM prompt, not guaranteed to prioritize credential detection —
 * and it runs long after several commits may have already landed in git
 * history for the phase. The CLAUDE.md guardrail against committing API
 * keys was enforced by nothing but trust in agent behavior.
 *
 * orchestrations/scripts/scan-secrets.sh is a generic, stack-agnostic
 * regex scanner over `git diff --cached` (added lines only), wired in
 * ahead of every real commit site in the pipeline. It intentionally uses
 * no project/stack-specific patterns — only well-known credential FORMATS
 * (AWS/GitHub/Slack/OpenAI/Google key prefixes, PEM private key blocks) and
 * one generic "var named password/secret/token/apikey assigned a
 * non-placeholder literal" rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCAN_SH = join(REPO_ROOT, 'orchestrations/scripts/scan-secrets.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
// commit_completed_story() itself moved to lib/git-ops.sh (2026-08-02 git-ops
// consolidation) — single source of truth shared by claude.sh,
// codemie-claude.sh, and run-agent-orchestration.sh.
const GIT_OPS_SH = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const gitOpsSrc = readFileSync(GIT_OPS_SH, 'utf8');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// These fixtures assemble credential-SHAPED strings at test-run time from
// split parts, rather than as a contiguous literal in this source file.
// scan-secrets.sh (and any other literal-pattern secret scanner, including
// GitHub's) matches file CONTENT, not how that content was constructed — the
// fixture written to the throwaway test repo below is byte-identical to the
// old inline literal, so detection coverage is unchanged. Only the risk of
// THIS test file itself being flagged as containing a credential is removed
// (found live 2026-08-03: a real GitHub secret-scanning alert fired on the
// old inline `'AKIA' + 16 uppercase chars` literal in this very file — a
// format-only match against a deliberately fake key, not a real leak, but
// the alert and remediation churn are real either way).
const FAKE_AWS_ACCESS_KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const FAKE_PEM_RSA_PRIVATE_KEY_BLOCK = [
  ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  'MIIEow==',
  ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
].join('\n');

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.com');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

function runScan(dir: string): { rc: number; stderr: string } {
  try {
    execFileSync('bash', [SCAN_SH, dir], { encoding: 'utf8' });
    return { rc: 0, stderr: '' };
  } catch (e: any) {
    return { rc: e.status ?? -1, stderr: (e.stderr ?? '').toString() };
  }
}

describe('scan-secrets.sh — generic credential scanner', () => {
  it('flags a hardcoded AWS Access Key ID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secret-scan-aws-'));
    try {
      const repo = freshRepo();
      writeFileSync(join(repo, 'leak.js'), `const key = '${FAKE_AWS_ACCESS_KEY_ID}';\n`);
      git(repo, 'add', 'leak.js');
      const { rc, stderr } = runScan(repo);
      expect(rc).toBe(1);
      expect(stderr).toMatch(/AWS Access Key ID/);
      rmSync(repo, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a PEM private key block', () => {
    const repo = freshRepo();
    try {
      writeFileSync(join(repo, 'id_rsa.js'), `${FAKE_PEM_RSA_PRIVATE_KEY_BLOCK}\n`);
      git(repo, 'add', 'id_rsa.js');
      const { rc, stderr } = runScan(repo);
      expect(rc).toBe(1);
      expect(stderr).toMatch(/PEM private key/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('flags a generic hardcoded token assignment', () => {
    const repo = freshRepo();
    try {
      writeFileSync(join(repo, 'generic.js'), "const authToken = 'thisisAreal32charTOKENvalueXYZ12';\n");
      git(repo, 'add', 'generic.js');
      const { rc, stderr } = runScan(repo);
      expect(rc).toBe(1);
      expect(stderr).toMatch(/generic credential/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT flag a real credential referenced via an environment variable', () => {
    const repo = freshRepo();
    try {
      writeFileSync(join(repo, 'clean.js'), 'const key = process.env.RAPIDAPI_KEY;\n');
      git(repo, 'add', 'clean.js');
      const { rc } = runScan(repo);
      expect(rc).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT flag an obvious test/placeholder value', () => {
    const repo = freshRepo();
    try {
      writeFileSync(join(repo, 'fixture.test.js'), "const apiKey = 'test-dummy-not-a-real-secret-value';\n");
      git(repo, 'add', 'fixture.test.js');
      const { rc } = runScan(repo);
      expect(rc).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is a no-op (exit 0) when nothing is staged', () => {
    const repo = freshRepo();
    try {
      const { rc } = runScan(repo);
      expect(rc).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('commit_completed_story() (claude.sh) — gated by scan-secrets.sh before commit', () => {
  const fnStart = gitOpsSrc.indexOf('commit_completed_story() {');
  const fnEnd = gitOpsSrc.indexOf('\n}', fnStart);
  const body = gitOpsSrc.slice(fnStart, fnEnd);

  it('calls scan-secrets.sh after staging (git add) and before the real commit', () => {
    const addIdx = body.indexOf('git -C "$_commit_root" add -A');
    const scanIdx = body.indexOf('scan-secrets.sh');
    const commitIdx = body.indexOf('git -C "$_commit_root" commit');
    expect(addIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeGreaterThan(addIdx);
    expect(commitIdx).toBeGreaterThan(scanIdx);
  });

  it('unstages and refuses to commit when the scan detects a likely secret', () => {
    expect(body).toMatch(/git -C "\$_commit_root" reset/);
    expect(body).toMatch(/SECRET_SCAN|secret/i);
  });

  it('SKIP_SECRET_SCAN defaults to true — scan is skipped unless explicitly set to false', () => {
    expect(body).toContain('SKIP_SECRET_SCAN:-true');
  });
});

describe('Step 1.5 auto-commit (run-agent-orchestration.sh) — gated by scan-secrets.sh', () => {
  it('calls scan-secrets.sh after `git add -A` and before the commit', () => {
    const stepIdx = orchSrc.indexOf('Step 9: Auto-committing main-branch deliverables');
    const block = orchSrc.slice(stepIdx, stepIdx + 2600);
    const addIdx = block.indexOf('git -C "$PROJECT_ROOT" add -A');
    const scanIdx = block.indexOf('scan-secrets.sh');
    const commitIdx = block.indexOf('git -C "$PROJECT_ROOT" commit');
    expect(addIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeGreaterThan(addIdx);
    expect(commitIdx).toBeGreaterThan(scanIdx);
  });
});

describe('commit_completed_story() — REAL execution proves a planted secret blocks the commit', () => {
  // callSite mirrors the ACTUAL call site in run_implementation()
  // (claude.sh): `commit_completed_story "$story_id" || true`. Root cause
  // this models (found live, 2026-07-14, tier3-travel-app run): a bare,
  // unguarded call to a function that legitimately returns 1 is ITSELF a
  // set -e trigger at the call site — this is true no matter how gracefully
  // the function itself fails internally, so the real fix has two parts:
  // (1) the function's own internal statements must not ALSO die before
  // reaching its intended `return 1` (see the git-add / scan-secrets fixes
  // below), and (2) the call site must not be bare. This harness always
  // includes part (2) via `callSite`, matching production usage.
  function runCommitCompletedStory(
    dir: string,
    opts: { setE: boolean; callSite: string; skipSecretScan?: boolean },
  ): { output: string; exitedGracefully: boolean } {
    const _fnStart = gitOpsSrc.indexOf('commit_completed_story() {');
    const _fnEnd = gitOpsSrc.indexOf('\n}', _fnStart);
    const fnBody = gitOpsSrc.slice(_fnStart, _fnEnd + 2);
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        // claude.sh itself runs under `set -e` (line 18) — the real
        // environment this function always executes in. The harness must
        // replicate that, or a set-e-unsafe statement inside the function
        // (found live, 2026-07-14: two of them, in the git-add and
        // scan-secrets blocks) silently passes here while still being able
        // to kill the real script.
        opts.setE ? 'set -e' : '',
        `GIT_WORK_ROOT=${JSON.stringify(dir)}`,
        `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations', 'scripts'))}`,
        'EPAM_COMMIT_TIMEOUT_SECS=10',
        // Scan defaults to SKIP_SECRET_SCAN=true; execution tests that need
        // the scan to run must explicitly opt in with skipSecretScan: false.
        `SKIP_SECRET_SCAN=${opts.skipSecretScan === false ? 'false' : 'true'}`,
        'log() { echo "LOG: $*"; }',
        'warning() { echo "WARN: $*"; }',
        'error() { echo "ERROR: $*"; }',
        fnBody,
        opts.callSite,
        'echo "REACHED_END rc=$?"',
      ].filter(Boolean).join('\n'),
    );
    let output = '';
    try {
      output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } catch (e: any) {
      output = ((e.stdout ?? '').toString()) + ((e.stderr ?? '').toString());
    }
    return { output, exitedGracefully: output.includes('REACHED_END') };
  }

  it('a story that wrote a real-looking AWS key does not get committed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-secret-block-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git(dir, 'add', 'README.md');
      git(dir, 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'src.js'), `const key = '${FAKE_AWS_ACCESS_KEY_ID}';\n`);

      const { output } = runCommitCompletedStory(dir, {
        setE: false,
        callSite: 'commit_completed_story "SKY-TEST"',
        skipSecretScan: false,
      });
      const log = git(dir, 'log', '--oneline');
      expect(log).not.toMatch(/SKY-TEST: story complete/);
      expect(output).toMatch(/SECRET_SCAN|secret/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real call site in run_implementation() (claude.sh) protects the call with || true, not a bare invocation', () => {
    const loopStart = claudeSrc.indexOf('for story_id in "${stories[@]}"; do');
    const loopBody = claudeSrc.slice(loopStart, claudeSrc.indexOf('EPAM CLI Orchestration Loop Complete', loopStart));
    expect(loopBody).toMatch(/commit_completed_story "\$story_id" \|\| true/);
  });

  // REPRODUCES the exact live defect (found live, 2026-07-14, tier3-travel-app
  // run) and proves the fix: under `set -e` (claude.sh's real environment),
  // a secret-scan rejection used to silently kill the ENTIRE worktree-lane
  // script — TWO compounding bugs: (1) `_scan_output=$(bash "$_scan_sh" ...)`
  // as a bare assignment is itself a set -e trigger when the command
  // substitution's command exits non-zero (which scan-secrets.sh does
  // intentionally on a hit) — this died one statement before the function's
  // OWN "Refusing to commit" warning ever printed; (2) even after fixing
  // that, a bare call to a function that legitimately returns 1 is ALSO a
  // set -e trigger at the CALL SITE. Every remaining story in that worktree
  // lane was silently abandoned, with worktree-health-check.sh later
  // finding uncommitted files and reporting "the agent did not commit its
  // own changes" — no indication a secret scan was ever involved.
  it('REPRODUCES the live defect and proves the fix: under set -e, with the real || true call site, a secret-scan rejection is handled gracefully instead of killing the whole script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-secret-sete-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git(dir, 'add', 'README.md');
      git(dir, 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'src.js'), `const key = '${FAKE_AWS_ACCESS_KEY_ID}';\n`);

      const { output, exitedGracefully } = runCommitCompletedStory(dir, {
        setE: true,
        callSite: 'commit_completed_story "SKY-TEST" || true',
        skipSecretScan: false,
      });
      expect(exitedGracefully).toBe(true);
      expect(output).toMatch(/REACHED_END rc=0/);
      expect(output).toMatch(/SECRET_SCAN|secret/i);
      const log = git(dir, 'log', '--oneline');
      expect(log).not.toMatch(/SKY-TEST: story complete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the function itself, called bare under set -e (no caller protection), still dies at the call site — proving || true at the call site is load-bearing, not redundant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-secret-bare-sete-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git(dir, 'add', 'README.md');
      git(dir, 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'src.js'), `const key = '${FAKE_AWS_ACCESS_KEY_ID}';\n`);

      const { output, exitedGracefully } = runCommitCompletedStory(dir, {
        setE: true,
        callSite: 'commit_completed_story "SKY-TEST"',
        skipSecretScan: false,
      });
      // Its own warning DOES print now (the internal git-add/scan-secrets
      // fixes work) but the script still dies right after, at the bare
      // call site itself -- REACHED_END is never reached.
      expect(output).toMatch(/SECRET_SCAN|secret/i);
      expect(exitedGracefully).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('under set -e, a clean commit (no secret) still succeeds and reaches the end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-clean-sete-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git(dir, 'add', 'README.md');
      git(dir, 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'src.js'), "export const greet = () => 'hello';\n");

      const { output, exitedGracefully } = runCommitCompletedStory(dir, {
        setE: true,
        callSite: 'commit_completed_story "SKY-TEST" || true',
        skipSecretScan: false,
      });
      expect(exitedGracefully).toBe(true);
      expect(output).toMatch(/REACHED_END rc=0/);
      const log = git(dir, 'log', '--oneline');
      expect(log).toMatch(/SKY-TEST: story complete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
