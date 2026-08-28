/**
 * The reviewer must also review the test-writer's TEST, not just the fix (2026-07-24).
 * The reviewer scopes its diff to STORY_FILES = story.technicalNotes.files (the declared FIX
 * files). The test-writer creates a NEW co-located test (<fixfile>.spec.ts) that is NOT in
 * technicalNotes.files, so the scoped diff excluded it — the test got only the deterministic
 * repro-gate (does it reproduce?) but never the reviewer's QUALITY judgment (over-mocking,
 * trivial assertions, asserting the mechanism not the observable). The test-writer is a new
 * agent; its output must be reviewed like the fix. Fix: the reviewer's diff scope = STORY_FILES
 * plus any test files (spec / test / __tests__ / _test) changed in baseline..HEAD.
 *
 * Drives the REAL STORY_DIFF block from team-lead-review.sh against a git fixture.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function extractBlock(): string {
  const start = SH.indexOf('STORY_DIFF=""');
  const end = SH.indexOf('# Load review-agent profile', start);
  return SH.slice(start, end);
}
const block = extractBlock();
const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

// Fixture: baseline (buggy fix.ts, no test) → story (fixed fix.ts + NEW co-located fix.spec.ts).
function makeRepo(): { repo: string; logDir: string } {
  const repo = mkdtempSync(join(tmpdir(), 'rev-test-'));
  const logDir = mkdtempSync(join(tmpdir(), 'rev-log-'));
  dirs.push(repo, logDir);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'fix.ts'), 'export const v = "BUGGY_CODE";\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  writeFileSync(join(logDir, 'phase-baseline-sha.txt'), git(repo, ['rev-parse', 'HEAD']).trim() + '\n');
  // story: the fix + a NEW co-located test the test-writer produced
  writeFileSync(join(repo, 'src', 'fix.ts'), 'export const v = "FIXED_CODE";\n');
  writeFileSync(join(repo, 'src', 'fix.spec.ts'), 'it("REPRO_TEST_MARKER", () => expect(1).toBe(1));\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'story: fix + test']);
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

describe('reviewer scope includes the test-writer\'s committed test', () => {
  it('reviews BOTH the declared fix AND a co-located test not in technicalNotes.files', () => {
    const { repo, logDir } = makeRepo();
    // STORY_FILES only has the declared fix — the test file is NOT declared
    const out = runDiff(repo, logDir, 'src/fix.ts');
    expect(out).toContain('FIXED_CODE');        // the fix is reviewed
    expect(out).toContain('REPRO_TEST_MARKER'); // the test-writer's test is ALSO reviewed
  });
});
