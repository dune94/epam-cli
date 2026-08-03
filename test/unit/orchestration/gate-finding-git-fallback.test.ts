/**
 * Fix for a live gap (2026-07-08, tier3 scaffold phase): the earlier
 * gate-remediation-eligibility fix made the self-heal pipeline reachable for
 * content-based gate failures (see [[project prior fix]] — sast_exit/etc.
 * now correctly populate _failing_logs), but gate-finding-analyst still
 * couldn't ground a SAST finding into a story_id when the finding's `file`
 * (tsconfig.json) isn't listed in any story's technicalNotes.files — shared
 * scaffold config that no single story "owns" on paper. Remediation was
 * reachable but produced nothing actionable.
 *
 * Fix: a deterministic fallback. Every file that was ever actually written
 * IS attributable via git — post-story commits always use the exact message
 * "<id>: story complete (N file(s))" (claude.sh's post-story commit step).
 * When the LLM can't ground a finding, ask git who last touched the file
 * instead of skipping remediation outright.
 *
 * This test extracts the REAL fallback block from run-agent-orchestration.sh
 * and runs it against a real git repo with real commit history.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractFallbackBlock(): string {
  const start = orchSrc.indexOf('if [ -z "$_story_id" ] || [ "$_story_id" = "null" ]; then');
  const end = orchSrc.indexOf('info "  [gate-finding-analyst] Finding mapped to story: ${_story_id}"');
  if (start === -1 || end === -1) throw new Error('fallback block anchors not found');
  return orchSrc.slice(start, end);
}

function makeGitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fallback-fixture-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function commitFile(repo: string, relPath: string, content: string, message: string): void {
  writeFileSync(join(repo, relPath), content);
  execFileSync('git', ['add', relPath], { cwd: repo });
  execFileSync('git', ['commit', '-m', message, '--quiet'], { cwd: repo });
}

function runFallback(opts: { projectRoot: string; glogContent: string; initialStoryId?: string }): {
  storyId: string;
  skipped: boolean;
  info: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fallback-run-'));
  try {
    const glogPath = join(dir, 'gate.log');
    writeFileSync(glogPath, opts.glogContent);
    const fallbackBlock = extractFallbackBlock();
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -uo pipefail
warning() { echo "WARNING: $*"; }
info() { echo "INFO: $*"; }
run_fallback() {
  local PROJECT_ROOT="${opts.projectRoot}"
  local _glog="${glogPath}"
  local _glabel="sast-sentinel"
  local _story_id="${opts.initialStoryId ?? ''}"
  local SKIPPED=0
${fallbackBlock.replace('continue', 'SKIPPED=1')}
  echo "STORY_ID=$_story_id"
  echo "SKIPPED=$SKIPPED"
}
run_fallback
`,
    );
    const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    return {
      storyId: output.match(/STORY_ID=(.*)$/m)?.[1]?.trim() ?? '',
      skipped: output.includes('SKIPPED=1'),
      info: output,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('gate-finding-analyst git-blame fallback — REAL execution', () => {
  it('attributes a shared config file (tsconfig.json) to the story whose commit last touched it', () => {
    const repo = makeGitFixture();
    try {
      commitFile(repo, 'tsconfig.json', '{}', 'SKY-001-impl: story complete (3 file(s))');
      const glog = JSON.stringify({
        findings: [{ severity: 'blocker', file: join(repo, 'tsconfig.json'), description: 'no inputs' }],
      });
      const { storyId, skipped } = runFallback({ projectRoot: repo, glogContent: glog });
      expect(storyId).toBe('SKY-001-impl');
      expect(skipped).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('uses the MOST RECENT commit when a file was touched by multiple stories', () => {
    const repo = makeGitFixture();
    try {
      commitFile(repo, 'package.json', '{"v":1}', 'SKY-001-impl: story complete (1 file(s))');
      commitFile(repo, 'package.json', '{"v":2}', 'SKY-001-test: story complete (1 file(s))');
      const glog = JSON.stringify({ findings: [{ file: join(repo, 'package.json') }] });
      const { storyId } = runFallback({ projectRoot: repo, glogContent: glog });
      expect(storyId).toBe('SKY-001-test');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls through to skip when the file was never committed under a "<id>: story complete" message', () => {
    const repo = makeGitFixture();
    try {
      commitFile(repo, 'README.md', 'hello', 'chore: unrelated commit');
      const glog = JSON.stringify({ findings: [{ file: join(repo, 'README.md') }] });
      const { storyId, skipped } = runFallback({ projectRoot: repo, glogContent: glog });
      expect(storyId).toBe('');
      expect(skipped).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls through to skip when the finding log has no parseable "file" field at all', () => {
    const repo = makeGitFixture();
    try {
      const { storyId, skipped } = runFallback({ projectRoot: repo, glogContent: 'not json at all, no file field here' });
      expect(storyId).toBe('');
      expect(skipped).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls through to skip when the file field points at a path that does not actually exist on disk', () => {
    const repo = makeGitFixture();
    try {
      const glog = JSON.stringify({ findings: [{ file: join(repo, 'does-not-exist.json') }] });
      const { storyId, skipped } = runFallback({ projectRoot: repo, glogContent: glog });
      expect(storyId).toBe('');
      expect(skipped).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT engage the fallback at all when the LLM already grounded a story_id (fallback is last-resort only)', () => {
    const repo = makeGitFixture();
    try {
      commitFile(repo, 'tsconfig.json', '{}', 'SKY-999-should-not-be-used: story complete (1 file(s))');
      const glog = JSON.stringify({ findings: [{ file: join(repo, 'tsconfig.json') }] });
      const { storyId, skipped } = runFallback({ projectRoot: repo, glogContent: glog, initialStoryId: 'SKY-001-real' });
      expect(storyId).toBe('SKY-001-real');
      expect(skipped).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
