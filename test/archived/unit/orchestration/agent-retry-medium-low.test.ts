/**
 * Agent retry coverage for medium (M1-M5) and low (L1-L3) severity findings
 * from the agent resilience audit. Verifies all 8 single-shot agents now have
 * at least 1 retry with a corrective re-prompt before failing or continuing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH_SH, 'utf8');

// ── M1: spec-coordinator (run_hybrid_precoordination) ────────────────────────
describe('M1: spec-coordinator (hybrid pre-coordination) — retry (M1)', () => {
  it('wraps spec-coordinator call in a 2-attempt loop', () => {
    expect(src).toMatch(/_hpc_attempt.*lt 2/);
    expect(src).toMatch(/_hpc_ok.*=.*[01]/);
  });

  it('retries with a corrective note on attempt 2', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*spec-coordinator|RETRY.*attempt 2.*[Hh]ybrid/s);
  });

  it('validates coord_log is non-empty before claiming success', () => {
    expect(src).toMatch(/-s.*coord_log.*_hpc_ok|_hpc_ok.*-s.*coord_log/s);
  });

  it('falls back with warning when both attempts produce no output', () => {
    expect(src).toMatch(/continuing with bash fallback/);
  });
});

// ── M2: story-recovery-analyst ───────────────────────────────────────────────
describe('M2: story-recovery-analyst — retry on empty/unparseable response (M2)', () => {
  it('declares _sra_attempt retry counter near the analyst call', () => {
    expect(src).toMatch(/_sra_attempt.*lt 2/);
  });

  it('provides a corrective re-prompt with expected JSON format on retry', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*restructure.*true.*false/s);
  });

  it('validates response is non-empty AND parseable JSON before accepting', () => {
    expect(src).toMatch(/_sra_raw.*python3.*json\.load/s);
  });

  it('logs a distinct warning (not silent return) when all attempts fail', () => {
    expect(src).toMatch(/story-recovery-analyst.*no parseable.*2 attempt/);
  });

  it('returns 1 (not false restructure) on exhaustion', () => {
    // After exhaustion, return 1 prevents silent "restructure=false" wrong answer
    expect(src).toMatch(/story-recovery-analyst.*no parseable.*after 2 attempt[\s\S]{1,200}return 1/);
  });
});

// ── M3: gate-finding-analyst ─────────────────────────────────────────────────
describe('M3: gate-finding-analyst — retry on empty output (M3)', () => {
  it('declares _gfa_attempt retry counter near the analyst call', () => {
    expect(src).toMatch(/_gfa_attempt.*lt 2/);
  });

  it('provides a corrective re-prompt instructing ReadFile on retry', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*ReadFile.*gate log|RETRY.*attempt 2.*gate log.*ReadFile/s);
  });

  it('escalates to ESCALATION_MODEL_HIGH on retry', () => {
    // Must set _gfa_model to ESCALATION_MODEL_HIGH when _gfa_attempt >= 1
    expect(src).toMatch(/_gfa_model.*ESCALATION_MODEL_HIGH|ESCALATION_MODEL_HIGH.*_gfa_model/s);
  });

  it('warns distinctly (not silent continue) when empty after attempt 1', () => {
    expect(src).toMatch(/gate-finding-analyst.*attempt 1.*no output/);
  });

  it('skips remediation with warning after both attempts exhausted', () => {
    expect(src).toMatch(/gate-finding-analyst.*no output after 2 attempt/);
    expect(src).toMatch(/gate-finding-analyst.*no output after 2 attempt[\s\S]{1,100}continue/);
  });
});

// ── M4: story-ac-remediator ──────────────────────────────────────────────────
describe('M4: story-ac-remediator — retry on empty output (M4)', () => {
  it('declares _acr_attempt retry counter near the remediator call', () => {
    expect(src).toMatch(/_acr_attempt.*lt 2/);
  });

  it('provides a corrective re-prompt with expected JSON format on retry', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*acs_added.*acs.*\[/s);
  });

  it('escalates to ESCALATION_MODEL_HIGH on retry', () => {
    expect(src).toMatch(/_acr_model.*ESCALATION_MODEL_HIGH|ESCALATION_MODEL_HIGH.*_acr_model/s);
  });

  it('warns (not silently skips) when empty after attempt 1', () => {
    expect(src).toMatch(/story-ac-remediator.*attempt 1.*no output/);
  });
});

// ── M5: run_phase_assessment ─────────────────────────────────────────────────
describe('M5: run_phase_assessment — retry on rc != 0 or no new record (M5)', () => {
  it('declares _pa_attempt retry counter near the assessment call', () => {
    expect(src).toMatch(/_pa_attempt.*lt 2/);
    expect(src).toMatch(/_pa_success/);
  });

  it('provides a corrective re-prompt on retry with reference to assessment_file', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*assessment.*phase/s);
  });

  it('escalates to ESCALATION_MODEL_HIGH on retry', () => {
    expect(src).toMatch(/ORCH_GATE_MODEL.*ESCALATION_MODEL_HIGH[\s\S]{1,500}team-lead-agent/s);
  });

  it('restores ORCH_GATE_MODEL after the retry loop', () => {
    expect(src).toMatch(/_saved_pa_model[\s\S]{1,300}ORCH_GATE_MODEL.*_saved_pa_model/s);
  });

  it('retries on non-zero rc (not just missing record)', () => {
    // The continue inside the loop fires on _assessment_rc -ne 0
    expect(src).toMatch(/_assessment_rc.*-ne 0[\s\S]{1,150}_pa_attempt.*continue/s);
  });

  it('retries when the response is not valid JSON after attempt 1', () => {
    // Full agent audit, 2026-07-31: this step was rewritten to precompute
    // all data deterministically and narrow the LLM to a judgment-only,
    // no-tools call — "no new record written" (tracked via before/after
    // grep counts) no longer applies since the orchestrator, not the
    // agent, writes the record. The retry now fires on invalid JSON output.
    expect(src).toMatch(/no valid JSON.*retrying|retrying.*no valid JSON/s);
  });

  it('warns non-critically and returns 1 after exhaustion', () => {
    expect(src).toMatch(/failed after 2 attempt.*no assessment record.*non-critical.*continuing/);
  });
});

// ── L1: skills-coordinator ───────────────────────────────────────────────────
describe('L1: skills-coordinator — retry with corrective note (L1)', () => {
  it('declares _sc_attempt retry counter near the skills-coordinator call', () => {
    expect(src).toMatch(/_sc_attempt.*lt 2/);
  });

  it('provides a corrective re-prompt instructing to read profiles file on retry', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*profiles\.json|RETRY.*attempt 2.*flagged note/s);
  });

  it('warns on attempt 1 failure and continues to retry', () => {
    expect(src).toMatch(/skills-coordinator.*attempt 1.*failed.*retrying/);
  });

  it('warns when both attempts fail — leaving as-is', () => {
    expect(src).toMatch(/skills-coordinator.*failed to rewrite.*leaving as-is/);
  });

  it('breaks out immediately on profiles.json corruption without retrying', () => {
    // Corruption path must not retry (would just corrupt again)
    expect(src).toMatch(/corrupted profiles\.json[\s\S]{1,250}break/s);
  });
});

// ── L2: tools-coordinator ────────────────────────────────────────────────────
describe('L2: tools-coordinator — retry with bash -n error in corrective note (L2)', () => {
  it('declares _tc_attempt retry counter near the tools-coordinator call', () => {
    expect(src).toMatch(/_tc_attempt.*lt 2/);
  });

  it('captures bash -n error output into corrective re-prompt', () => {
    expect(src).toMatch(/_tc_bn_err[\s\S]{1,200}_tc_run_prompt.*_tc_bn_err/s);
  });

  it('includes bash -n error text in RETRY prompt', () => {
    expect(src).toMatch(/RETRY.*bash -n.*reports/s);
  });

  it('warns on attempt 1 broken tool and continues to retry', () => {
    expect(src).toMatch(/tools-coordinator.*left.*broken on attempt 1.*retrying/);
  });

  it('restores from backup after both attempts leave tool broken', () => {
    expect(src).toMatch(/syntactically broken after 2 attempt[\s\S]{1,100}Restoring pre-audit snapshot/s);
  });
});

// ── L3: profile-augmentor disk-verify retry ──────────────────────────────────
describe('L3: profile-augmentor — retry when disk unchanged after profile_updated claim (L3)', () => {
  it('declares _pfa3_attempt retry counter + _pfa3_disk_changed flag', () => {
    expect(src).toMatch(/_pfa3_attempt.*lt 2/);
    expect(src).toMatch(/_pfa3_disk_changed/);
  });

  it('provides corrective note instructing WriteFile on retry', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*WriteFile.*profiles\.json/s);
  });

  it('warns on attempt 1 disk-unchanged and retries', () => {
    expect(src).toMatch(/profile-augmentor.*unchanged.*retrying with corrective note/);
  });

  it('warns and treats as no-op after 2 attempts with no disk change', () => {
    expect(src).toMatch(/still unchanged on disk after 2 attempt.*treating as no-op/);
  });

  it('skips to next gate (continue) only after both attempts exhausted', () => {
    // The guard uses _pfa3_disk_changed = 0 as the continue condition
    expect(src).toMatch(/_pfa3_disk_changed.*=.*0[\s\S]{1,100}continue/s);
  });

  it('breaks out of loop immediately when disk does change (disk_changed=1)', () => {
    expect(src).toMatch(/_pfa3_disk_changed=1/);
  });
});
