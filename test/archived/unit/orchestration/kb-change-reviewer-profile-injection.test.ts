/**
 * kb-change-reviewer's own rule set includes "Entry contradicts the
 * agentRole's profile in profiles.json" — but until 2026-07-31 (full agent
 * audit) the kb_entry call site only ever passed the KB markdown file's last
 * 6 lines as review context, never the target role's actual profile.json
 * text. Unlike the skill_note call site (whose "before" IS the target
 * profile text, since skill notes are appended to the profile directly),
 * the reviewer had no way to check that specific rule for kb_entry changes —
 * it could only guess or ignore it.
 *
 * Fixed by fetching the target agentRole's profile text the same way the
 * skill_note branch already does (`jq -c --arg role "$story_role"
 * '.[$role] // ""'`) and folding it into the review context passed to
 * run_change_with_reviewer_retry, labeled so the reviewer can actually apply
 * the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

function kbEntryBlock(): string {
  const i = SRC.indexOf('local _kb_last3=""');
  expect(i, 'the kb_entry review-context block is gone — this is anchored to nothing').toBeGreaterThan(-1);
  return SRC.slice(i, i + 1300);
}

describe('kb_entry review context includes the target role\'s real profile text', () => {
  it('fetches the target agentRole profile via jq, same as the skill_note branch', () => {
    expect(kbEntryBlock(), 'the kb_entry branch still never fetches the target profile — ' +
      'the "contradicts the agentRole\'s profile" rule remains unenforceable')
      .toMatch(/jq -c --arg role "\$story_role" '\.\[\$role\] \/\/ ""'/);
  });

  it('labels the injected profile text so the reviewer knows which rule it grounds', () => {
    expect(kbEntryBlock()).toMatch(/contradicts the agentRole's profile/i);
  });

  it('still preserves the KB-file dedup context (last entries) alongside the new profile text', () => {
    expect(kbEntryBlock()).toMatch(/_kb_last3/);
  });

  it('passes the combined context (not just the KB tail) to run_change_with_reviewer_retry', () => {
    const i = SRC.indexOf('_kb_review_verdict=$(run_change_with_reviewer_retry');
    expect(i).toBeGreaterThan(-1);
    const call = SRC.slice(i, i + 250);
    expect(call).toMatch(/"\$_kb_review_before"/);
  });
});

describe('the reviewer prompt itself has no unescaped quotes (regression anchor)', () => {
  // Found live while building this fix: an inserted prompt paragraph with
  // literal unescaped double quotes inside review_prompt="..." silently
  // corrupted the string at the shell-parsing level (bash -n stayed clean —
  // alternating quoted/unquoted concatenation is syntactically legal, just
  // semantically wrong) and broke a real-execution test
  // (reviewer-summarizer-retry.test.ts) in a way that had nothing to do with
  // its actual assertions. Anchor against a repeat.
  it('run_prd_change_reviewer\'s prompt has no bare " between the AFTER block and the Emit line', () => {
    const start = SRC.indexOf('AFTER:\n${after_json:0:1000}');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('Emit ONLY:', start);
    expect(end).toBeGreaterThan(start);
    const between = SRC.slice(start, end);
    expect(between, 'a bare " here prematurely closes the review_prompt="..." assignment')
      .not.toMatch(/[^\\]"/);
  });
});
