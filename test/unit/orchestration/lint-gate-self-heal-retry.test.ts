/**
 * Step 3.8 lint-gate self-heal retry coverage (LG1-LG3).
 * Three `epam run --json` calls were single-shot with `|| echo ""` / `|| true`
 * fallbacks — same silent-wrong-answer class as M3/M4 in the QA gate pipeline.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorSource } from '../../helpers/orchestrator-source';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
// Reads the orchestrator AND the libs lifted out of it: run_orch_prompt and the gate verdict
// logic now live under lib/. The property is about the SHIPPED path, not about which file
// happens to hold a function today. See test/helpers for the single definition.
const src = orchestratorSource();

// ── LG1: gate-finding-analyst (lint path) ────────────────────────────────────
describe('LG1: lint-gate gate-finding-analyst — retry on empty output', () => {
  it('declares _lga_attempt retry counter near the lint analyst call', () => {
    expect(src).toMatch(/_lga_attempt.*lt 2/);
  });

  it('retries with corrective note instructing ReadFile on attempt 2', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*lint log.*\$\{_lint_log\}/s);
  });

  it('escalates to ESCALATION_MODEL_HIGH on retry', () => {
    expect(src).toMatch(/_lga_model.*ESCALATION_MODEL_HIGH|ESCALATION_MODEL_HIGH.*_lga_model/s);
  });

  it('warns on attempt 1 empty output', () => {
    expect(src).toMatch(/lint-gate:analyst.*attempt 1.*no output/);
  });

  it('warns when both attempts return nothing', () => {
    expect(src).toMatch(/lint-gate:analyst.*all 2 attempts.*no output/);
  });

  it('keeps _lint_finding_raw empty after exhaustion (not a silent echo "")', () => {
    // The outer `if [ -n "$_lint_finding_raw" ]` guard then skips remediation properly
    expect(src).toMatch(/_lint_finding_raw=""\s*\n\s*_lga_attempt/s);
  });
});

// ── LG2: story-ac-remediator (lint path) ─────────────────────────────────────
describe('LG2: lint-gate story-ac-remediator — retry on empty output', () => {
  it('declares _lrem_attempt retry counter near the lint remediator call', () => {
    expect(src).toMatch(/_lrem_attempt.*lt 2/);
  });

  it('retries with corrective note including expected JSON format', () => {
    expect(src).toMatch(/RETRY.*attempt 2.*new_acs/s);
  });

  it('escalates to ESCALATION_MODEL_HIGH on retry', () => {
    expect(src).toMatch(/_lrem_model.*ESCALATION_MODEL_HIGH|ESCALATION_MODEL_HIGH.*_lrem_model/s);
  });

  it('warns on attempt 1 empty output', () => {
    expect(src).toMatch(/lint-gate:remediator.*attempt 1.*no output/);
  });

  it('warns when both attempts return nothing', () => {
    expect(src).toMatch(/lint-gate:remediator.*all 2 attempts.*no output/);
  });

  it('_lint_ac_raw is initialized empty before the retry loop', () => {
    expect(src).toMatch(/_lint_ac_raw=""\s*\n\s*_lrem_attempt/s);
  });
});

// ── LG3: profile-augmentor (lint path) ───────────────────────────────────────
describe('LG3: lint-gate profile-augmentor — retry on empty output', () => {
  it('captures augmentor output before deciding whether to retry', () => {
    expect(src).toMatch(/_laug_raw="\$\(echo "\$_lint_finding_raw"/);
  });

  it('warns on attempt 1 empty output and retries', () => {
    expect(src).toMatch(/lint-gate:augmentor.*attempt 1.*no output.*retrying/);
  });

  it('uses || true on retry (still fire-and-forget, not a hard failure)', () => {
    expect(src).toMatch(/lint-gate:augmentor[\s\S]{1,600}\|\| true/s);
  });
});
