/**
 * Root cause of a systemic defect (run #12/#13, 2026-07-03): across a single
 * run, EVERY kb_entry and several skill_note self-heal writes were rejected by
 * run_prd_change_reviewer for pure FORMAT reasons (over 200 chars, wrong verb
 * tense, references a specific story ID, truncated mid-sentence) and then
 * silently discarded — the underlying lesson was usually sound, only its shape
 * was wrong, but there was no retry: one rejection meant the content was gone
 * forever and self-heal persistence effectively never worked.
 *
 * Fix: run_change_with_reviewer_retry() wraps run_prd_change_reviewer with a
 * summarize-and-resubmit loop. On rejection, run_prd_change_summarizer() asks
 * the gate model to rewrite the candidate to address the reviewer's stated
 * issues (PRD_REVIEW_ISSUES, exposed by run_prd_change_reviewer), then
 * resubmits — up to 3 total review attempts before giving up. Wired into both
 * the kb_entry and skill_note call sites in claude.sh.
 *
 * Requires no external API key — uses a local fake ai-run.sh stub, since this
 * tests control flow (retry-until-pass, give-up-after-N), not model quality.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
// The template-layer renderer. Extracted claude.sh functions render their prompts through
// it, so a harness must source it just as it stubs log() and error().
const RENDER_LIB = join(__dirname, '../../../orchestrations/scripts/lib/render-engine-prompt.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = claudeSrc.indexOf(`${name}()`);
  const end = claudeSrc.indexOf('\n}', start) + 2;
  return claudeSrc.slice(start, end);
}

// Pulls the exact declaration line for a top-level global var out of
// claude.sh, rather than duplicating its default value in this test file --
// _skill_note_format_ok reads SKILL_NOTE_IMPERATIVE_OPENERS as its single
// source of truth for the accepted-imperative-word list; without it set,
// the check's regex becomes `^()\b` and trivially matches everything,
// short-circuiting run_change_with_reviewer_retry's deterministic pre-check
// to "pass" for ANY candidate and defeating the very reviewer path these
// tests exist to exercise.
function extractGlobalVarLine(name: string): string {
  const re = new RegExp(`^${name}=.*$`, 'm');
  const match = re.exec(claudeSrc);
  if (!match) throw new Error(`Global var ${name} not found`);
  return match[0];
}

const IMPERATIVE_OPENERS_VAR = extractGlobalVarLine('SKILL_NOTE_IMPERATIVE_OPENERS');

const FAKE_AI_RUN_FIXES_ON_RETRY = `#!/usr/bin/env bash
prompt=$(cat)
if echo "$prompt" | grep -q "PRD change summarizer"; then
  echo "Always validate import paths before writing them."
else
  after_section=$(echo "$prompt" | sed -n '/^AFTER:/,$p')
  if echo "$after_section" | grep -q "BADFORMAT"; then
    echo '{"verdict":"fail","issues":["exceeds 200 chars; references story ID; not imperative"],"reason":"format"}'
  else
    echo '{"verdict":"pass","issues":[],"reason":"ok"}'
  fi
fi
`;

const FAKE_AI_RUN_NEVER_FIXES = `#!/usr/bin/env bash
prompt=$(cat)
if echo "$prompt" | grep -q "PRD change summarizer"; then
  # Summarizer "fixes" it but the fix still contains the trigger marker —
  # simulates a summarizer that can't actually satisfy the reviewer.
  echo "BADFORMAT still bad after rewrite"
else
  echo '{"verdict":"fail","issues":["still bad"],"reason":"format"}'
fi
`;

function runRetryScenario(fakeAiRun: string, candidate: string, maxRetries = 3): { verdict: string; finalText: string; summarizerCalls: number } {
  const dir = mkdtempSync(join(tmpdir(), 'reviewer-retry-test-'));
  try {
    const aiRunPath = join(dir, 'ai-run.sh');
    writeFileSync(aiRunPath, fakeAiRun);
    chmodSync(aiRunPath, 0o755);

    const formatCheckBody = extractFunctionBody('_skill_note_format_ok');
    const reviewerBody = extractFunctionBody('run_prd_change_reviewer');
    const summarizerBody = extractFunctionBody('run_prd_change_summarizer');
    const retryBody = extractFunctionBody('run_change_with_reviewer_retry');

    const script = `
SCRIPT_DIR="${dir}"
TMPDIR="${dir}"
ORCH_GATE_PROVIDER="fake"
ORCH_GATE_MODEL="fake-model"
profiles_file=""
warning() { :; }
log() { :; }
error() { :; }
source ${JSON.stringify(RENDER_LIB)}
${IMPERATIVE_OPENERS_VAR}
${formatCheckBody}
${reviewerBody}
${summarizerBody}
${retryBody}
verdict=$(run_change_with_reviewer_retry "SKY-004" "kb_entry" "" "${candidate}" ${maxRetries})
final_text=$(cat "${dir}/.reviewer-retry-text-$$" 2>/dev/null || echo "")
echo "VERDICT=$verdict"
echo "FINAL_TEXT=$final_text"
`;
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);
    const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });

    const verdict = output.match(/VERDICT=(\w+)/)?.[1] ?? '';
    const finalText = output.match(/FINAL_TEXT=(.*)$/m)?.[1] ?? '';
    return { verdict, finalText, summarizerCalls: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('run_change_with_reviewer_retry — REAL execution', () => {
  it('when the summarizer fixes the format issue, the retry succeeds and returns the rewritten text', () => {
    const { verdict, finalText } = runRetryScenario(
      FAKE_AI_RUN_FIXES_ON_RETRY,
      'BADFORMAT this note references SKY-002 and exceeds two hundred characters of allowed length for a knowledge base entry which the reviewer will reject on the first pass before the summarizer rewrites it',
    );
    expect(verdict).toBe('pass');
    expect(finalText).toBe('Always validate import paths before writing them.');
  });

  it('when nothing the summarizer produces satisfies the reviewer, gives up after max_retries and reports fail', () => {
    const { verdict } = runRetryScenario(FAKE_AI_RUN_NEVER_FIXES, 'BADFORMAT original', 3);
    expect(verdict).toBe('fail');
  });

  it('a candidate that passes on the FIRST review attempt never invokes the summarizer at all', () => {
    const fakeAiRun = `#!/usr/bin/env bash
cat > /dev/null
echo '{"verdict":"pass","issues":[],"reason":"ok"}'
`;
    const { verdict, finalText } = runRetryScenario(fakeAiRun, 'Always validate paths first.');
    expect(verdict).toBe('pass');
    expect(finalText).toBe('Always validate paths first.');
  });
});

describe('claude.sh — reviewer-retry wired into kb_entry and skill_note self-heal', () => {
  it('kb) case calls run_change_with_reviewer_retry (not run_prd_change_reviewer directly) with max_retries=3', () => {
    const kbCaseIdx = claudeSrc.indexOf('_kb_review_verdict=$(run_change_with_reviewer_retry');
    expect(kbCaseIdx).toBeGreaterThan(-1);
    const callBlock = claudeSrc.slice(kbCaseIdx, kbCaseIdx + 250);
    expect(callBlock).toMatch(/"kb_entry"/);
    expect(callBlock).toMatch(/3\)/);
  });

  it('kb) case writes REVIEWER_RETRY_TEXT (the possibly-reformatted text) to the KB file on the APPROVED path, not the original short_note', () => {
    // 2026-07-06: a rejected-after-3-attempts fallback append was added right
    // before the approved-path append (writes $short_note tagged
    // "[unreviewed-fallback]", not $REVIEWER_RETRY_TEXT) — so this test now
    // targets the SECOND ">> "$kb_file"" occurrence (the approved branch),
    // not just the first one found after the case starts.
    const kbCaseIdx = claudeSrc.indexOf('_kb_review_verdict=$(run_change_with_reviewer_retry');
    const fallbackAppendIdx = claudeSrc.indexOf('>> "$kb_file"', kbCaseIdx);
    const approvedAppendIdx = claudeSrc.indexOf('>> "$kb_file"', fallbackAppendIdx + 1);
    expect(approvedAppendIdx).toBeGreaterThan(fallbackAppendIdx);
    const appendLine = claudeSrc.slice(claudeSrc.lastIndexOf('\n', approvedAppendIdx), claudeSrc.indexOf('\n', approvedAppendIdx));
    expect(appendLine).toMatch(/REVIEWER_RETRY_TEXT/);
  });

  it('kb) case ALSO persists a fallback (tagged "[unreviewed-fallback]", using $short_note) on the rejected path, instead of discarding the note', () => {
    const kbCaseIdx = claudeSrc.indexOf('_kb_review_verdict=$(run_change_with_reviewer_retry');
    const fallbackAppendIdx = claudeSrc.indexOf('>> "$kb_file"', kbCaseIdx);
    const fallbackLine = claudeSrc.slice(claudeSrc.lastIndexOf('\n', fallbackAppendIdx), claudeSrc.indexOf('\n', fallbackAppendIdx));
    expect(fallbackLine).toMatch(/unreviewed-fallback/);
    expect(fallbackLine).toMatch(/short_note/);
  });

  it('skill) case calls run_change_with_reviewer_retry with max_retries=3', () => {
    const skillCaseIdx = claudeSrc.indexOf('_skill_review_verdict=$(run_change_with_reviewer_retry');
    expect(skillCaseIdx).toBeGreaterThan(-1);
    const callBlock = claudeSrc.slice(skillCaseIdx, skillCaseIdx + 350);
    expect(callBlock).toMatch(/"skill_note"/);
    expect(callBlock).toMatch(/3\)/);
  });

  // DESTINATION CHANGED 2026-08-07 (ARCH-5): the reviewed text is appended to the codeline KB
  // rather than written into profiles.json. The concern is exactly as before — what gets
  // persisted is the REVIEWER'S text, not the raw skill_note the reviewer just rewrote.
  it('skill) case persists REVIEWER_RETRY_TEXT to the KB, not the original skill_note variable', () => {
    const skillCaseIdx = claudeSrc.indexOf('_skill_review_verdict=$(run_change_with_reviewer_retry');
    expect(skillCaseIdx).toBeGreaterThan(-1);
    const appendIdx = claudeSrc.indexOf('>> "$_skill_kb_file"', skillCaseIdx);
    expect(appendIdx).toBeGreaterThan(skillCaseIdx);
    const appendLine = claudeSrc.slice(claudeSrc.lastIndexOf('\n', appendIdx), appendIdx + 24);
    expect(
      appendLine,
      'the raw pre-review note is being persisted, discarding the reviewer rewrite',
    ).toMatch(/REVIEWER_RETRY_TEXT/);
  });
});
