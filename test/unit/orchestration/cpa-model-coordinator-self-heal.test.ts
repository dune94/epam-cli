/**
 * Self-healing audit fixes #2 and #3.
 *
 * #2 — CPA pre-pass (contextualize-stories.sh --apply) writes effort,
 * estimatedHours/Cost/Tokens/Turns, cpaConfidence, and cpaGate directly to
 * PRD stories with zero review. The `effort` field feeds resolve_effort_
 * settings (iteration/token budget) and prd-model-coordinator's
 * reasoningEffort default — a bad value silently propagates into execution
 * config. Fix: a per-story reviewer gate (change type cpa_estimate) with
 * surgical revert of just the CPA-written fields on reject.
 *
 * #3 — Step 0.5 pre-phase skill assessment has full tool access to create
 * brand-new agent profiles from scratch and append arbitrary skill rules to
 * existing ones (including sast-sentinel, review-ranger). The only existing
 * safeguard (`jq empty`) catches JSON syntax corruption, not bad content.
 * Fix: a structural before/after diff (new_profiles + changed_profiles) fed
 * to the reviewer (change type profile_creation), with whole-file revert on
 * reject.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const CPA_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const PROFILES = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const PROFILES_ORIG = join(REPO_ROOT, 'orchestrations/agents/profiles.json.original');

const cpaSrc = readFileSync(CPA_SCRIPT, 'utf8');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');
const profiles = JSON.parse(readFileSync(PROFILES, 'utf8'));
const profilesOrig = JSON.parse(readFileSync(PROFILES_ORIG, 'utf8'));

// ── Fix #2: CPA pre-pass reviewer gate ───────────────────────────────────────

describe('contextualize-stories.sh — CPA apply-mode reviewer gate', () => {
  it('defines _cpa_profiles_file and _cpa_ai_runner_cmd before the apply loop', () => {
    const applyIdx = cpaSrc.indexOf('Apply mode — write blended estimates');
    const loopIdx = cpaSrc.indexOf('while IFS= read -r sid', applyIdx);
    const block = cpaSrc.slice(applyIdx, loopIdx);
    expect(block).toMatch(/_cpa_profiles_file=/);
    expect(block).toMatch(/_cpa_ai_runner_cmd=/);
  });

  it('snapshots the story\'s CPA fields from the backup before overwriting (surgical revert target)', () => {
    expect(cpaSrc).toMatch(/_cpa_before=\$\(jq --arg id "\$sid" '\.stories\[\] \| select\(\.id==\$id\)/);
    expect(cpaSrc).toMatch(/"\$backup"/);
  });

  it('calls the reviewer with change type cpa_estimate', () => {
    expect(cpaSrc).toMatch(/CHANGE TYPE: cpa_estimate/);
  });

  it('is gated by ORCH_GATE_PROVIDER (non-blocking when gate unconfigured)', () => {
    const reviewIdx = cpaSrc.indexOf('CHANGE TYPE: cpa_estimate');
    const surroundingBlock = cpaSrc.slice(Math.max(0, reviewIdx - 700), reviewIdx);
    expect(surroundingBlock).toMatch(/if \[ -n "\$\{ORCH_GATE_PROVIDER:-\}" \]/);
  });

  it('reverts only the CPA-written fields (surgical, not whole-file) on reject', () => {
    const rejectIdx = cpaSrc.indexOf('CPA estimate REJECTED by reviewer');
    expect(rejectIdx).toBeGreaterThan(-1);
    const block = cpaSrc.slice(rejectIdx, rejectIdx + 300);
    expect(block).toMatch(/\$_cpa_before/);
    expect(block).toMatch(/jq --arg id "\$sid" --argjson before/);
  });

  it('uses the gate model (ORCH_GATE_MODEL, default MiniMax-M3), not a story-agent model', () => {
    const reviewIdx = cpaSrc.indexOf('CHANGE TYPE: cpa_estimate');
    const block = cpaSrc.slice(reviewIdx, reviewIdx + 700);
    expect(block).toMatch(/ORCH_GATE_MODEL:-MiniMax-M3/);
  });
});

describe('prd-change-reviewer — cpa_estimate change type coverage', () => {
  const reviewer: string = profiles['prd-change-reviewer'];

  it('documents cpa_estimate as a recognized change type', () => {
    expect(reviewer).toMatch(/cpa_estimate/);
  });

  it('rejects effort values outside low/medium/high', () => {
    expect(reviewer).toMatch(/effort is not one of: low, medium, high/i);
  });

  it('rejects cpaGate values outside pass/review/block', () => {
    expect(reviewer).toMatch(/cpaGate is not one of: pass, review, block/i);
  });

  it('rejects negative or zero estimates for stories that require work', () => {
    expect(reviewer).toMatch(/negative or zero/i);
  });

  it('rejects out-of-range cpaConfidence', () => {
    expect(reviewer).toMatch(/cpaConfidence is outside the 0-1 range/i);
  });
});

// ── Fix #3: Step 0.5 pre-phase skill assessment reviewer gate ────────────────

describe('run-agent-orchestration.sh — Step 0.5 profile-mutation reviewer gate', () => {
  // Windows widened 4000/5000 -> 5500 (2026-07-13): the 3-attempt
  // retry-on-violation loop (new PRD field-allowlist checker,
  // PFA_PRD_DIFF_PY) added ~1300 chars before the reviewer-gate section
  // these tests anchor into, pushing it past the old fixed-size windows.
  it('snapshots profiles.json fresh at the start of run_pre_phase_assessment (not the canonical backup)', () => {
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    // 9000, not 5500: the asserted strings sit ~5.9K chars in, and a fixed window
    // reported a correct ORDERING as absent the moment comments were added above
    // them. The invariant is the order, not the byte offset.
    const block = orchSrc.slice(fnIdx, fnIdx + 9000);
    expect(block).toMatch(/_pfa_profiles_before=/);
  });

  it('runs the reviewer gate AFTER the jq-empty syntax check (syntax check is not replaced, only supplemented)', () => {
    // NO fixed window. This assertion is about ORDER, so it compares positions
    // in the source directly. The window was already widened once (5500 -> 9000)
    // for exactly this reason, and adding a tool-budget block to the assessment
    // prompt pushed the markers past 9000 too — a correct ordering reported as
    // absent, for the third time. A byte offset was never the invariant.
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    expect(fnIdx, 'anchor not found').toBeGreaterThan(-1);
    const syntaxIdx = orchSrc.indexOf('jq empty "$profiles_file"', fnIdx);
    const reviewerIdx = orchSrc.indexOf('CHANGE TYPE: profile_creation', fnIdx);
    expect(syntaxIdx, 'the jq-empty syntax check is gone').toBeGreaterThan(-1);
    expect(reviewerIdx, 'the reviewer gate is gone').toBeGreaterThan(-1);
    expect(reviewerIdx, 'the reviewer gate no longer follows the syntax check')
      .toBeGreaterThan(syntaxIdx);
  });

  it('computes a structural diff (new_profiles vs changed_profiles) instead of a raw text tail excerpt', () => {
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    // 9000, not 5500: the asserted strings sit ~5.9K chars in, and a fixed window
    // reported a correct ORDERING as absent the moment comments were added above
    // them. The invariant is the order, not the byte offset.
    const block = orchSrc.slice(fnIdx, fnIdx + 9000);
    expect(block).toMatch(/new_profiles/);
    expect(block).toMatch(/changed_profiles/);
  });

  it('writes the before-snapshot to a temp file rather than interpolating raw JSON into a python heredoc', () => {
    // The interpolation approach is fragile (unescaped quotes/backslashes in
    // profile text can break the heredoc). Must use a file-based handoff.
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    // 9000, not 5500: the asserted strings sit ~5.9K chars in, and a fixed window
    // reported a correct ORDERING as absent the moment comments were added above
    // them. The invariant is the order, not the byte offset.
    const block = orchSrc.slice(fnIdx, fnIdx + 9000);
    expect(block).toMatch(/_pfa_before_tmp=\$\(mktemp\)/);
    expect(block).toMatch(/printf '%s' "\$_pfa_profiles_before" > "\$_pfa_before_tmp"/);
    expect(block).toMatch(/open\(sys\.argv\[1\]\)/);
  });

  it('only calls the reviewer when the diff actually contains changes (skips the LLM call otherwise)', () => {
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    // 9000, not 5500: the asserted strings sit ~5.9K chars in, and a fixed window
    // reported a correct ORDERING as absent the moment comments were added above
    // them. The invariant is the order, not the byte offset.
    const block = orchSrc.slice(fnIdx, fnIdx + 9000);
    expect(block).toMatch(/_pfa_has_changes/);
  });

  it('calls the reviewer with change type profile_creation', () => {
    expect(orchSrc).toMatch(/CHANGE TYPE: profile_creation/);
  });

  it('reverts profiles.json wholesale to the pre-call snapshot on reject', () => {
    // Anchor updated (2026-07-13): the reviewer's own "REJECTED by reviewer"
    // warning was replaced by a tracked _pfa_violation_reason (the revert
    // itself moved to a shared block after the retry loop, common to both
    // this reviewer AND the new PRD-side checker — see the next describe
    // block's "reverted" outcome test for the actual revert-on-exhaustion
    // proof). This confirms the violation is still recorded when the
    // reviewer rejects, which is what feeds that shared revert.
    const rejectIdx = orchSrc.indexOf('profiles.json content was rejected by the reviewer');
    expect(rejectIdx).toBeGreaterThan(-1);
    const block = orchSrc.slice(rejectIdx - 150, rejectIdx + 50);
    expect(block).toMatch(/_pfa_violated=1/);
  });

  it('is gated by ORCH_GATE_PROVIDER (skips the whole review block when gate unconfigured)', () => {
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    // 9000, not 5500: the asserted strings sit ~5.9K chars in, and a fixed window
    // reported a correct ORDERING as absent the moment comments were added above
    // them. The invariant is the order, not the byte offset.
    const block = orchSrc.slice(fnIdx, fnIdx + 9000);
    expect(block).toMatch(/if \[ -n "\$\{ORCH_GATE_PROVIDER:-\}" \]/);
  });

  it('cleans up the temp file after computing the diff', () => {
    const fnIdx = orchSrc.indexOf("_pfa_profiles_before=");
    // 9000, not 5500: the asserted strings sit ~5.9K chars in, and a fixed window
    // reported a correct ORDERING as absent the moment comments were added above
    // them. The invariant is the order, not the byte offset.
    const block = orchSrc.slice(fnIdx, fnIdx + 9000);
    expect(block).toMatch(/rm -f "\$_pfa_before_tmp"/);
  });
});

describe('prd-change-reviewer — profile_creation change type coverage', () => {
  const reviewer: string = profiles['prd-change-reviewer'];

  it('documents profile_creation as a recognized change type', () => {
    expect(reviewer).toMatch(/profile_creation/);
  });

  it('rejects new profiles missing file-writing scope instructions', () => {
    expect(reviewer).toMatch(/file-writing scope/i);
  });

  it('rejects new profiles introducing out-of-stack technology', () => {
    const idx = reviewer.indexOf('profile_creation');
    const block = reviewer.slice(idx, idx + 600);
    // De-hardcoded 2026-07-29 (STACK-1): the frozen list named the travel-app's
    // stack and rejected correct Contentstack guidance on metrolinx. The rule
    // must STILL reject out-of-stack technology — now measured against the
    // codeline actually in front of it.
    expect(block).toMatch(/technology this project does not already use/);
  });

  it('rejects test-engineer-role profiles that do not forbid writing implementation files', () => {
    expect(reviewer).toMatch(/test-engineer-role profile does not explicitly forbid/i);
  });

  it('rejects profiles that duplicate an existing role', () => {
    expect(reviewer).toMatch(/duplicates an existing profile's role/i);
  });

  it('is present identically in profiles.json.original (all 3 new change types)', () => {
    expect(profilesOrig['prd-change-reviewer']).toBe(reviewer);
    expect(profilesOrig['prd-change-reviewer']).toMatch(/spec_pass/);
    expect(profilesOrig['prd-change-reviewer']).toMatch(/cpa_estimate/);
    expect(profilesOrig['prd-change-reviewer']).toMatch(/profile_creation/);
  });
});
