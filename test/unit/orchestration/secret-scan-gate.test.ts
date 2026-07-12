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
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

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
      writeFileSync(join(repo, 'leak.js'), "const key = 'AKIAABCDEFGHIJKLMNOP';\n");
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
      writeFileSync(join(repo, 'id_rsa.js'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n');
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
  const fnStart = claudeSrc.indexOf('commit_completed_story() {');
  const fnEnd = claudeSrc.indexOf('\n}', fnStart);
  const body = claudeSrc.slice(fnStart, fnEnd);

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
});

describe('Step 1.5 auto-commit (run-agent-orchestration.sh) — gated by scan-secrets.sh', () => {
  it('calls scan-secrets.sh after `git add -A` and before the commit', () => {
    const stepIdx = orchSrc.indexOf('Step 1.5: Auto-committing main-branch deliverables');
    const block = orchSrc.slice(stepIdx, stepIdx + 1200);
    const addIdx = block.indexOf('git -C "$PROJECT_ROOT" add -A');
    const scanIdx = block.indexOf('scan-secrets.sh');
    const commitIdx = block.indexOf('git -C "$PROJECT_ROOT" commit');
    expect(addIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeGreaterThan(addIdx);
    expect(commitIdx).toBeGreaterThan(scanIdx);
  });
});

describe('commit_completed_story() — REAL execution proves a planted secret blocks the commit', () => {
  it('a story that wrote a real-looking AWS key does not get committed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commit-secret-block-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 't@t.com');
      git(dir, 'config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git(dir, 'add', 'README.md');
      git(dir, 'commit', '-qm', 'base');
      writeFileSync(join(dir, 'src.js'), "const key = 'AKIAABCDEFGHIJKLMNOP';\n");

      const _fnStart = claudeSrc.indexOf('commit_completed_story() {');
      const _fnEnd = claudeSrc.indexOf('\n}', _fnStart);
      const fnBody = claudeSrc.slice(_fnStart, _fnEnd + 2);
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          `GIT_WORK_ROOT=${JSON.stringify(dir)}`,
          `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations', 'scripts'))}`,
          'EPAM_COMMIT_TIMEOUT_SECS=10',
          'log() { echo "LOG: $*"; }',
          'warning() { echo "WARN: $*"; }',
          'error() { echo "ERROR: $*"; }',
          fnBody,
          'commit_completed_story "SKY-TEST"',
          'echo "EXIT:$?"',
        ].join('\n'),
      );
      let output = '';
      try {
        output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      } catch (e: any) {
        output = ((e.stdout ?? '').toString()) + ((e.stderr ?? '').toString());
      }
      const log = git(dir, 'log', '--oneline');
      expect(log).not.toMatch(/story: complete SKY-TEST/);
      expect(output).toMatch(/SECRET_SCAN|secret/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
