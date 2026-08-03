/**
 * team-lead-review.sh's REVIEW_PROMPT must force the reviewer to VERIFY a
 * test-coverage claim with a tool before flagging a scenario as missing —
 * not judge from a visual skim of the diff.
 *
 * ESCAPED DEFECT (found live, 2026-08-03, AMSD-2041 upexpress): the reviewer
 * has real tool access (EPAM_ALLOWED_TOOLS="bash,read_file,list_files,search")
 * but the prompt only forced grounded verification for ONE class of claim
 * (the CONCISION & REUSE section's "verify with the tool above" instruction,
 * for reuse/helper claims). Test-coverage claims got a bare "Check: ...test
 * coverage" with no forcing function. Confirmed live: the reviewer claimed 2
 * of 3 required test scenarios were missing, TWICE in a row (00:21:19 and
 * 00:25:23, per orchestrations logs), against an UNCHANGED diff that
 * unambiguously contained all 3 as clearly-named `it(...)` blocks (verified
 * directly: `git diff 1f79748 950ddcd -- ... | grep 'it("should include
 * live_preview'` etc. all matched). This is not "the model is unreliable" —
 * it's that the SAME tools were available for the reuse check and forced
 * there, but not for test-coverage claims. Root cause traced with the user
 * (2026-08-03): "I don't think the reviewer issue is 'the model' - it is what
 * tool or instructions the model has."
 *
 * Fix: a TEST COVERAGE VERIFICATION section, same shape as CONCISION & REUSE,
 * requiring a search/read_file check before any "missing test" claim, and
 * requiring the reviewer to name the search it ran when it finds nothing —
 * so a genuinely absent test is distinguishable from an unverified guess.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEAM_LEAD_REVIEW = join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh');
const src = readFileSync(TEAM_LEAD_REVIEW, 'utf8');

describe('team-lead-review.sh — TEST COVERAGE VERIFICATION prompt section (static)', () => {
  it('exists, in the same prompt block as CONCISION & REUSE', () => {
    const reuseIdx = src.indexOf('CONCISION & REUSE');
    const testCoverageIdx = src.indexOf('TEST COVERAGE VERIFICATION');
    const respondIdx = src.indexOf('Respond with ONLY a JSON object');
    expect(reuseIdx).toBeGreaterThan(-1);
    expect(testCoverageIdx).toBeGreaterThan(reuseIdx);
    expect(respondIdx).toBeGreaterThan(testCoverageIdx);
  });

  it('requires a tool-based search BEFORE flagging a scenario as missing', () => {
    const idx = src.indexOf('TEST COVERAGE VERIFICATION');
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/[Bb]efore flagging ANY .*missing/);
    expect(block).toMatch(/search tool/);
  });

  it('distinguishes "missing" from "inadequate" (a found-but-wrong test must not be reported as absent)', () => {
    const idx = src.indexOf('TEST COVERAGE VERIFICATION');
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/missing.*and.*inadequate.*(different|must not be conflated)/is);
  });

  it('requires naming the search performed when a scenario is genuinely reported absent', () => {
    const idx = src.indexOf('TEST COVERAGE VERIFICATION');
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/name the exact search/);
  });
});

const cleanupDirs: string[] = [];
function cleanup() {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

describe('team-lead-review.sh — REVIEW_PROMPT construction (REAL bash execution)', () => {
  it('the prompt assignment does not abort under set -euo pipefail, and backticks render literally (not swallowed as command substitution)', () => {
    // Extract the real, unmodified REVIEW_PROMPT assignment by marker — the
    // exact defect class this test guards against is a backtick inside a
    // double-quoted bash string being interpreted as command substitution
    // instead of literal text (an easy mistake when adding code-fence-style
    // instructions to an LLM prompt embedded in bash).
    const startMarker = 'REVIEW_PROMPT="${REVIEW_PROFILE}';
    const endMarker = "A 'blocker' issue MUST be fixed before merge. 'major' should be fixed. 'minor' is optional.\"";
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf(endMarker, startIdx) + endMarker.length;
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const assignment = src.slice(startIdx, endIdx);

    const dir = mkdtempSync(join(tmpdir(), 'review-prompt-'));
    cleanupDirs.push(dir);
    const scriptPath = join(dir, 'probe.sh');
    writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'REVIEW_PROFILE="You are a reviewer."',
        'story_id="TEST-1"',
        'STORY_TITLE="test story"',
        'STORY_DESC="a description"',
        'STORY_ACS="- AC1"',
        'STORY_VC=""',
        'STORY_FIX_ANALYSIS=""',
        'STORY_FILES="src/x.ts"',
        '_test_files=""',
        'STORY_DIFF="+ it(\\"should do the thing\\", () => {});"',
        'PROJECT_ROOT="/tmp/fake-project"',
        '_review_codegraph_tool=""',
        '_review_kb=""',
        assignment,
        'echo "$REVIEW_PROMPT"',
      ].join('\n'),
    );
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    // Literal backticks must survive into the output, not be stripped/evaluated.
    expect(out).toContain('`it(`');
    expect(out).toContain('TEST COVERAGE VERIFICATION');
    cleanup();
  });
});
