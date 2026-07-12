/**
 * run_failure_analyst's "skill" case must not re-persist an exact-duplicate
 * skill note via the unreviewed-fallback path.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run):
 * SKY-003-test's test-engineer profile ended up with the note
 * "[Self-Heal] Do not reuse validation logic across different flags..."
 * persisted TWICE — once cleanly, once again tagged
 * "[Self-Heal] [unreviewed-fallback] Do not reuse validation logic...".
 * The 2026-07-10 fix already made the exact-duplicate check see the FULL
 * profile text (not a truncated head -c 500), so run_change_with_reviewer_
 * retry correctly rejected the second occurrence as a duplicate (verdict
 * "fail") — but the unreviewed-fallback path right below it, designed to
 * rescue a genuinely NEW lesson that failed 3 review rounds on WORDING
 * alone, didn't distinguish "rejected because it's a verbatim duplicate"
 * from "rejected for wording, still worth keeping" — it persisted the
 * duplicate anyway, defeating the entire dedup mechanism it sits next to.
 *
 * Fix: check for an exact duplicate FIRST (before ever calling the
 * reviewer) and skip the whole reviewer+persist flow when found — there is
 * nothing to review or fall back to for content that's already there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('skill-note duplicate guard — wiring (static)', () => {
  it('checks for an exact duplicate BEFORE calling run_change_with_reviewer_retry', () => {
    const dupIdx = claudeSrc.indexOf('grep -qF -- "$skill_note"');
    const reviewerIdx = claudeSrc.indexOf('_skill_review_verdict=$(run_change_with_reviewer_retry');
    expect(dupIdx).toBeGreaterThan(-1);
    expect(reviewerIdx).toBeGreaterThan(dupIdx);
  });

  it('logs and skips rather than falling through to the unreviewed-fallback path', () => {
    const idx = claudeSrc.indexOf('grep -qF -- "$skill_note"');
    const block = claudeSrc.slice(idx, idx + 300);
    expect(block).toMatch(/exact duplicate of an existing note/);
  });
});

describe('run_failure_analyst skill case — REAL execution', () => {
  function extractSkillCaseBody(): string {
    const start = claudeSrc.indexOf('                skill)');
    const end = claudeSrc.indexOf('\n                kb)');
    return claudeSrc.slice(start, end);
  }

  function run(opts: { existingProfileText: string; skillNote: string; reviewerVerdict: 'pass' | 'fail' }): {
    profilesAfter: string;
    logOutput: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'skill-dup-'));
    try {
      const profilesPath = join(dir, 'profiles.json');
      writeFileSync(profilesPath, JSON.stringify({ 'test-engineer': opts.existingProfileText }));

      const skillCaseBody = extractSkillCaseBody();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          'log() { echo "LOG: $*"; }',
          'warning() { echo "WARN: $*"; }',
          `profiles_file=${JSON.stringify(profilesPath)}`,
          `story_role="test-engineer"`,
          `story_id="SKY-003-test"`,
          `skill_note=${JSON.stringify(opts.skillNote)}`,
          '_profile_updated=""',
          // Stub the reviewer machinery: run_change_with_reviewer_retry just
          // echoes the pre-set verdict and writes the retry-text side channel,
          // matching the real function's documented contract.
          'run_change_with_reviewer_retry() {',
          `  printf '%s' "$4" > "\${TMPDIR:-/tmp}/.reviewer-retry-text-$$"`,
          `  echo ${opts.reviewerVerdict}`,
          '}',
          // The extracted body uses `local` throughout, which only works inside
          // a real function (in production this snippet always runs inside
          // run_failure_analyst) — wrap it in one here too.
          'run_skill_case() {',
          'case "skill" in',
          skillCaseBody,
          'esac',
          '}',
          'run_skill_case',
        ].join('\n'),
      );
      const logOutput = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const profilesAfter = readFileSync(profilesPath, 'utf8');
      return { profilesAfter, logOutput };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: a note the reviewer rejects as a duplicate is NOT re-persisted via unreviewed-fallback', () => {
    const note = 'Do not reuse validation logic across different flags; each flag must have its own dedicated validation branch.';
    const { profilesAfter, logOutput } = run({
      existingProfileText: `[Self-Heal] ${note}`,
      skillNote: note,
      reviewerVerdict: 'fail', // the reviewer correctly flags this as a duplicate
    });
    const profiles = JSON.parse(profilesAfter);
    const occurrences = (profiles['test-engineer'].match(/Do not reuse validation logic/g) || []).length;
    expect(occurrences).toBe(1); // still just the original — nothing new persisted
    expect(profiles['test-engineer']).not.toMatch(/unreviewed-fallback/);
    expect(logOutput).toMatch(/exact duplicate/);
  });

  it('still persists a genuinely NEW note that fails review 3x for wording (unreviewed-fallback still works for real new lessons)', () => {
    const { profilesAfter } = run({
      existingProfileText: 'Some pre-existing unrelated note.',
      skillNote: 'Always export a main function from CLI entry points for testability',
      reviewerVerdict: 'fail',
    });
    const profiles = JSON.parse(profilesAfter);
    expect(profiles['test-engineer']).toMatch(/unreviewed-fallback/);
    expect(profiles['test-engineer']).toMatch(/Always export a main function/);
  });

  it('still persists a genuinely new note that the reviewer approves (no regression to the normal pass path)', () => {
    const { profilesAfter } = run({
      existingProfileText: 'Some pre-existing unrelated note.',
      skillNote: 'Always export a main function from CLI entry points for testability',
      reviewerVerdict: 'pass',
    });
    const profiles = JSON.parse(profilesAfter);
    expect(profiles['test-engineer']).toMatch(/Always export a main function/);
    expect(profiles['test-engineer']).not.toMatch(/unreviewed-fallback/);
  });
});
