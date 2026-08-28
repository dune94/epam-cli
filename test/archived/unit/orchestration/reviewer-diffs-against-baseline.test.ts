/**
 * The team-lead reviewer must diff the story against its BASELINE SHA, not HEAD~N
 * (found live 2026-07-24, AMSD-1820). It collected the diff via `git diff HEAD~5 HEAD` /
 * `HEAD~3 HEAD`. The story branch is built on origin/<baseline>, so HEAD~N walks back into
 * the BASELINE branch's own recent commits — an unrelated upstream commit (AMSD-2285
 * "get-sb-client.ts / sb mi", nothing to do with the promo bug) landed in the reviewer's
 * diff, and its rule "a change addressing code the bug never reaches = blocker" fired,
 * rejecting a correct fix. The repro-gate already does it right: it diffs against
 * phase-baseline-sha.txt (= origin/<baseline>). The reviewer must use the same base so its
 * diff contains ONLY the story's changes.
 *
 * Drives the REAL STORY_DIFF block extracted from team-lead-review.sh against a git fixture.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Extract the STORY_DIFF collection block.
function extractBlock(): string {
  const start = SH.indexOf('STORY_DIFF=""');
  // end right after the diff-collection block (before profile loading)
  const end = SH.indexOf('# Load review-agent profile', start);
  return SH.slice(start, end);
}
const block = extractBlock();

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

// Fixture: init → A → B(baseline: unrelated upstream commit) → C(story fix). phase-baseline-sha=B.
function makeRepo(): { repo: string; logDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'rev-base-'));
  const logDir = mkdtempSync(join(tmpdir(), 'rev-log-'));
  dirs.push(repo, logDir);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'init\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'c0 init']);
  writeFileSync(join(repo, 'src', 'base.ts'), 'const base = 1;\n'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'c1']);
  // c2 = the story's BASELINE: an UNRELATED upstream commit (like AMSD-2285)
  writeFileSync(join(repo, 'src', 'unrelated.ts'), 'export const marker = "UPSTREAM_UNRELATED";\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'c2 unrelated upstream']);
  const baselineSha = git(repo, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), baselineSha + '\n');
  // c3 = the STORY: the actual fix
  writeFileSync(join(repo, 'src', 'fix.ts'), 'export const marker = "STORY_FIX";\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'c3 story fix']);
  return { repo, logDir };
}

function runDiff(repo: string, logDir: string, storyFiles: string): string {
  const script = `
STORY_DIFF=""
PROJECT_ROOT='${repo}'
LOG_DIR='${logDir}'
JIRA_BASELINE_BRANCH='develop'
STORY_FILES='${storyFiles}'
${block}
printf '%s' "$STORY_DIFF"
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('reviewer diff is scoped to the story vs its baseline SHA', () => {
  it('unscoped fallback: shows the story fix, NOT the unrelated upstream baseline commit', () => {
    const { repo, logDir } = makeRepo();
    // non-matching STORY_FILES → scoped diff empty → fallback path (where the bug lived)
    const out = runDiff(repo, logDir, 'src/does-not-exist.ts');
    expect(out).toContain('STORY_FIX');            // the story's change is present
    expect(out).not.toContain('UPSTREAM_UNRELATED'); // the baseline advancement is NOT
  });

  it('scoped path: diffing a story file uses the baseline base too', () => {
    const { repo, logDir } = makeRepo();
    const out = runDiff(repo, logDir, 'src/fix.ts');
    expect(out).toContain('STORY_FIX');
    expect(out).not.toContain('UPSTREAM_UNRELATED');
  });
});
