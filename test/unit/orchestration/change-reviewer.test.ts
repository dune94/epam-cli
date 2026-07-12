/**
 * Contract tests for prd-change-reviewer and kb-change-reviewer agents.
 *
 * Verifies:
 *   1. Both profiles exist and are meaningful
 *   2. prd-change-reviewer is called after every AC/TC patch and skill note in claude.sh
 *   3. prd-change-reviewer is called after profile-augmentor writes in run-agent-orchestration.sh
 *   4. kb-change-reviewer is called before every KB file append in claude.sh
 *   5. Revert paths exist for each reviewer rejection
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO         = join(__dirname, '../../../');
const PROFILES_FILE = join(REPO, 'orchestrations/agents/profiles.json');
const CLAUDE_SH    = join(REPO, 'orchestrations/scripts/claude.sh');
const ORCH_SH      = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

const profiles  = JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc   = readFileSync(ORCH_SH, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// prd-change-reviewer profile
// ─────────────────────────────────────────────────────────────────────────────

describe('prd-change-reviewer — profile', () => {
  const agent: string = profiles['prd-change-reviewer'] ?? '';

  it('profile key exists in profiles.json', () => {
    expect(profiles['prd-change-reviewer']).toBeTruthy();
    expect(typeof profiles['prd-change-reviewer']).toBe('string');
  });

  it('profile is non-trivially long (not a stub)', () => {
    expect(agent.length).toBeGreaterThan(300);
  });

  it('profile covers ac_patch change type', () => {
    expect(agent).toMatch(/ac_patch|AC patch|acceptanceCriteria/i);
  });

  it('profile covers tc_patch change type', () => {
    expect(agent).toMatch(/tc_patch|TC patch|testCriteria/i);
  });

  it('profile covers skill_note change type', () => {
    expect(agent).toMatch(/skill.note|skill_note/i);
  });

  it('profile covers profile_addendum change type', () => {
    expect(agent).toMatch(/profile.addendum|profile_addendum/i);
  });

  it('profile specifies pass|fail as the verdict values', () => {
    expect(agent).toMatch(/pass.*fail|fail.*pass/i);
  });

  it('profile specifies compact JSON output with verdict and issues fields', () => {
    expect(agent).toMatch(/"verdict"/);
    expect(agent).toMatch(/"issues"/);
  });

  it('profile rejects vague AC text (no measurable criterion)', () => {
    expect(agent).toMatch(/vague|measurable|works correctly/i);
  });

  it('profile rejects AC text with more than 12 items', () => {
    expect(agent).toMatch(/12/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// kb-change-reviewer profile
// ─────────────────────────────────────────────────────────────────────────────

describe('kb-change-reviewer — profile', () => {
  const agent: string = profiles['kb-change-reviewer'] ?? '';

  it('profile key exists in profiles.json', () => {
    expect(profiles['kb-change-reviewer']).toBeTruthy();
    expect(typeof profiles['kb-change-reviewer']).toBe('string');
  });

  it('profile is non-trivially long (not a stub)', () => {
    expect(agent.length).toBeGreaterThan(300);
  });

  it('profile defines the KB reviewer role', () => {
    expect(agent).toMatch(/KB.*reviewer|knowledge base.*reviewer/i);
  });

  it('profile rejects entries referencing specific story IDs', () => {
    expect(agent).toMatch(/story ID|SKY-xxx|EPAM-xxx/i);
  });

  it('profile requires entries to be generalizable (not one-time workarounds)', () => {
    expect(agent).toMatch(/generaliz|one-time workaround/i);
  });

  it('profile rejects entries longer than 200 characters', () => {
    expect(agent).toMatch(/200 characters/);
  });

  it('profile requires entries to start with an imperative verb', () => {
    expect(agent).toMatch(/Never|Always|Do not|imperative/i);
  });

  it('profile rejects technology outside the stack', () => {
    expect(agent).toMatch(/TypeScript.*Node.*Express.*Vitest|stack/i);
  });

  it('profile rejects duplicate entries', () => {
    expect(agent).toMatch(/duplicate|dedup|already.*covered/i);
  });

  it('profile specifies pass|fail verdict output', () => {
    expect(agent).toMatch(/"verdict"/);
    expect(agent).toMatch(/pass.*fail|fail.*pass/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run_prd_change_reviewer function in claude.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('claude.sh — run_prd_change_reviewer function', () => {
  it('function is defined', () => {
    expect(claudeSrc).toMatch(/run_prd_change_reviewer\s*\(\)/);
  });

  it('selects prd-change-reviewer profile for ac_patch/tc_patch/skill_note types', () => {
    const fnStart = claudeSrc.indexOf('run_prd_change_reviewer()');
    const fnEnd   = claudeSrc.indexOf('\n}', fnStart + 50);
    const body    = claudeSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/prd-change-reviewer/);
  });

  it('selects kb-change-reviewer profile when change_type is kb_entry', () => {
    const fnStart = claudeSrc.indexOf('run_prd_change_reviewer()');
    const fnEnd   = claudeSrc.indexOf('\n}', fnStart + 50);
    const body    = claudeSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/kb_entry/);
    expect(body).toMatch(/kb-change-reviewer/);
  });

  it('echoes "pass" when gate provider is not configured (non-blocking)', () => {
    const fnStart = claudeSrc.indexOf('run_prd_change_reviewer()');
    const fnEnd   = claudeSrc.indexOf('\n}', fnStart + 50);
    const body    = claudeSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/echo "pass"/);
    expect(body).toMatch(/gate_provider.*return 0|return 0/);
  });

  it('echoes "fail" and logs a warning when verdict is fail', () => {
    const fnStart = claudeSrc.indexOf('run_prd_change_reviewer()');
    const fnEnd   = claudeSrc.indexOf('\n}', fnStart + 50);
    const body    = claudeSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/verdict.*fail|fail.*verdict/i);
    expect(body).toMatch(/echo "fail"/);
  });

  it('calls ai-run.sh with the gate provider (not hardcoded model)', () => {
    const fnStart = claudeSrc.indexOf('run_prd_change_reviewer()');
    const fnEnd   = claudeSrc.indexOf('\n}', fnStart + 50);
    const body    = claudeSrc.slice(fnStart, fnEnd);
    expect(body).toMatch(/ai-run\.sh/);
    expect(body).toMatch(/gate_provider/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: run_prd_change_reviewer's return value must not be polluted by
// its own log/warning output.
//
// Root cause (found live, 2026-07-02 tier3 run): warning()/log() write to
// stdout (not just the progress log file). run_prd_change_reviewer called
// warning "  [PRD-Reviewer] REJECTED ..." with no redirect, immediately before
// `echo "fail"` — so every caller's command substitution
// ($(run_prd_change_reviewer ...)) captured a TWO-LINE string
// ("...REJECTED...\nfail"), not the bare word "fail". Every
// `[ "$verdict" = "fail" ]` check at every call site therefore silently
// evaluated false, meaning every rejection was treated as an approval and
// the rejected content was persisted anyway. Confirmed live: a skill note the
// reviewer explicitly rejected as "exceeds 200 characters... not
// generalizable" was appended to profiles.json in the very next log line.
// ─────────────────────────────────────────────────────────────────────────────

describe('claude.sh — run_prd_change_reviewer verdict is not polluted by its own logging', () => {
  const fnStart = claudeSrc.indexOf('run_prd_change_reviewer()');
  const fnEnd   = claudeSrc.indexOf('\n}', fnStart + 50);
  const body    = claudeSrc.slice(fnStart, fnEnd);

  it('redirects the REJECTED warning to stderr (does not pollute the captured verdict)', () => {
    const idx = body.indexOf('REJECTED');
    const line = body.slice(body.lastIndexOf('\n', idx), body.indexOf('\n', idx));
    expect(line).toMatch(/>&2/);
  });

  it('redirects the APPROVED log line to stderr (does not pollute the captured verdict)', () => {
    const idx = body.indexOf('APPROVED');
    const line = body.slice(body.lastIndexOf('\n', idx), body.indexOf('\n', idx));
    expect(line).toMatch(/>&2/);
  });

  it('no other warning()/log()/error()/success() call inside the function is missing >&2', () => {
    // Every bare (non-echo) log-style call inside this function must redirect to
    // stderr, since the function's entire stdout is captured via $(...) by callers.
    const logCalls = body.match(/\b(warning|log|error|success)\s+"[^"]*"/g) ?? [];
    for (const call of logCalls) {
      const callIdx = body.indexOf(call);
      const restOfLine = body.slice(callIdx, body.indexOf('\n', callIdx));
      expect(restOfLine, `Missing >&2 redirect: ${call}`).toMatch(/>&2/);
    }
  });

  it('REAL bash execution: a "fail" verdict is captured as exactly "fail" (not polluted)', () => {
    // Extract just the log/warning/error/success function definitions plus a
    // minimal stand-in for run_prd_change_reviewer's tail logic, and prove the
    // captured command-substitution result is the bare word "fail".
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const script = `${claudeSrc.match(/^log\(\) \{[\s\S]*?\n\}\n/m)?.[0] ?? ''}
${claudeSrc.match(/^warning\(\) \{[\s\S]*?\n\}\n/m)?.[0] ?? ''}
PROGRESS_LOG=/dev/null
test_reviewer() {
  local verdict="fail"
  if [ "$verdict" = "fail" ]; then
    warning "  [PRD-Reviewer] REJECTED test" >&2
    echo "fail"
  else
    log "  [PRD-Reviewer] APPROVED test" >&2
    echo "pass"
  fi
}
result=$(test_reviewer)
echo "RESULT=[$result]"
`;
    const tmpFile = path.join(os.tmpdir(), `verdict-pollution-test-${Date.now()}.sh`);
    fs.writeFileSync(tmpFile, script);
    try {
      const output = execFileSync('bash', [tmpFile], { encoding: 'utf8' });
      expect(output).toContain('RESULT=[fail]');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC patch reviewer wiring in claude.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('claude.sh — reviewer wired after AC patches', () => {
  it('snapshots ACs before patching (_ac_before)', () => {
    expect(claudeSrc).toMatch(/_ac_before/);
  });

  it('calls run_prd_change_reviewer with change_type=ac_patch', () => {
    expect(claudeSrc).toMatch(/run_prd_change_reviewer.*ac_patch/);
  });

  it('reverts ACs when reviewer returns fail', () => {
    expect(claudeSrc).toMatch(/AC patch rejected by reviewer — reverting to original ACs/i);
  });

  it('resets patch_count to 0 after AC revert', () => {
    // After AC revert the patch_count must be reset so healing recorder sees 0 patches applied
    const revertMsgIdx = claudeSrc.indexOf('AC patch rejected by reviewer');
    expect(revertMsgIdx).toBeGreaterThan(-1);
    const afterRevert = claudeSrc.slice(revertMsgIdx, revertMsgIdx + 900);
    expect(afterRevert).toMatch(/patch_count=0/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC patch reviewer wiring in claude.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('claude.sh — reviewer wired after TC patches', () => {
  it('snapshots TC facts before patching (_tc_before)', () => {
    expect(claudeSrc).toMatch(/_tc_before/);
  });

  it('calls run_prd_change_reviewer with change_type=tc_patch', () => {
    expect(claudeSrc).toMatch(/run_prd_change_reviewer.*tc_patch/);
  });

  it('reverts TC facts when reviewer returns fail', () => {
    expect(claudeSrc).toMatch(/TC patch rejected by reviewer — reverting to original facts/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Skill note reviewer wiring in claude.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('claude.sh — reviewer wired before skill note persistence', () => {
  it('calls run_prd_change_reviewer before writing skill note to profiles.json', () => {
    // reviewer call must appear BEFORE the python3 block that appends [Self-Heal] to profiles
    const skillBranchIdx   = claudeSrc.indexOf('_skill_review_verdict');
    const selfHealWriteIdx = claudeSrc.indexOf("'[Self-Heal] ' + sys.argv[1]");
    expect(skillBranchIdx).toBeGreaterThan(-1);
    expect(selfHealWriteIdx).toBeGreaterThan(-1);
    expect(skillBranchIdx).toBeLessThan(selfHealWriteIdx);
  });

  // 2026-07-06: a genuinely correct skill note was rejected 3 times purely for
  // WORDING (over the char limit, wrong verb) and the lesson was lost forever
  // — not just its phrasing. Rather than skip persistence entirely on
  // rejection, a length-safe, explicitly-tagged "[unreviewed-fallback]"
  // version is now persisted so the underlying knowledge survives even when
  // the reviewer's wording bar isn't met.
  it('logs the rejection but still persists an "[unreviewed-fallback]"-tagged version instead of discarding the note entirely', () => {
    expect(claudeSrc).toMatch(/Skill note rejected by reviewer/i);
    expect(claudeSrc).toMatch(/persisting raw fallback \(unreviewed\)/i);
    expect(claudeSrc).toMatch(/\[unreviewed-fallback\] \$\{skill_note:0:200\}/);
  });

  it('the fallback path still goes through the same profiles.json append code as an approved note (not a separate write path)', () => {
    const skillCaseIdx = claudeSrc.indexOf('_skill_review_verdict');
    const pythonWriteIdx = claudeSrc.indexOf("'[Self-Heal] ' + sys.argv[1]", skillCaseIdx);
    const fallbackIdx = claudeSrc.indexOf('persisting raw fallback (unreviewed)', skillCaseIdx);
    expect(fallbackIdx).toBeGreaterThan(skillCaseIdx);
    expect(pythonWriteIdx).toBeGreaterThan(fallbackIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KB entry reviewer wiring in claude.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('claude.sh — kb-change-reviewer wired before KB file append', () => {
  it('reads last 3 KB entries before calling reviewer (_kb_last3)', () => {
    expect(claudeSrc).toMatch(/_kb_last3/);
    expect(claudeSrc).toMatch(/tail.*kb_file|_kb_last3/);
  });

  it('calls run_prd_change_reviewer with change_type=kb_entry', () => {
    expect(claudeSrc).toMatch(/run_prd_change_reviewer[^)]*kb_entry/s);
  });

  it('KB file append happens after the reviewer verdict is known (approved content or fallback, either way)', () => {
    const kbReviewIdx = claudeSrc.indexOf('_kb_review_verdict');
    const kbAppendIdx2 = claudeSrc.indexOf('>> "$kb_file"', kbReviewIdx);
    expect(kbReviewIdx).toBeGreaterThan(-1);
    expect(kbAppendIdx2).toBeGreaterThan(kbReviewIdx);
  });

  // 2026-07-06: same root cause as the skill-note fallback above — a rejected
  // KB entry used to be silently discarded even when the underlying rule was
  // correct, just poorly worded. Now persists an "[unreviewed-fallback]"-
  // tagged version instead of losing the knowledge.
  it('logs the rejection but still persists an "[unreviewed-fallback]"-tagged version instead of discarding the note entirely', () => {
    const kbCaseIdx = claudeSrc.indexOf('_kb_review_verdict');
    const afterReview = claudeSrc.slice(kbCaseIdx, kbCaseIdx + 2200);
    expect(afterReview).toMatch(/rejected by reviewer/i);
    expect(afterReview).toMatch(/persisting raw fallback \(unreviewed\)/i);
    expect(afterReview).toMatch(/\[unreviewed-fallback\] %s/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// profile-augmentor reviewer wiring in run-agent-orchestration.sh
// ─────────────────────────────────────────────────────────────────────────────

describe('run-agent-orchestration.sh — reviewer wired after profile-augmentor', () => {
  it('snapshots profiles.json before augmentor runs (_profiles_before)', () => {
    expect(orchSrc).toMatch(/_profiles_before/);
  });

  it('reads profiles.json after augmentor writes (_profiles_after)', () => {
    expect(orchSrc).toMatch(/_profiles_after/);
  });

  it('calls ai-run.sh with prd-change-reviewer profile for profile_addendum type', () => {
    expect(orchSrc).toMatch(/prd-change-reviewer/);
    expect(orchSrc).toMatch(/profile_addendum/);
  });

  it('reverts profiles.json to _profiles_before on reviewer fail', () => {
    const reviewIdx  = orchSrc.indexOf('_review_verdict" = "fail"');
    expect(reviewIdx).toBeGreaterThan(-1);
    const afterRevert = orchSrc.slice(reviewIdx, reviewIdx + 300);
    expect(afterRevert).toMatch(/_profiles_before.*profiles_file|profiles_file.*profiles_before/s);
  });

  it('logs reviewer-approved when profile update passes review', () => {
    expect(orchSrc).toMatch(/reviewer approved/i);
  });
});
