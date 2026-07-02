/**
 * Failure Analyst — TDD contract tests for the self-healing Layer 3 in claude.sh.
 *
 * Principle: we test the FRAMEWORK, not the travel app.
 * - No reads from travel-app-prd.canonical.json (that is runtime data)
 * - Structural invariants verified via source inspection
 * - Data-driven tests use mock fixtures from test/fixtures/
 * - Tests encode run 102 / 103 root causes so those failures cannot recur silently
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH    = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const MOCK_PRD     = join(__dirname, '../../fixtures/mock-prd.json');
const MOCK_PROFILES = join(__dirname, '../../fixtures/mock-profiles.json');

const src          = readFileSync(CLAUDE_SH, 'utf8');
const mockPrd      = JSON.parse(readFileSync(MOCK_PRD, 'utf8'));
const mockProfiles = JSON.parse(readFileSync(MOCK_PROFILES, 'utf8'));

// ── 1. Function definition ────────────────────────────────────────────────────
describe('claude.sh — run_failure_analyst function is defined', () => {
  it('defines run_failure_analyst as a shell function', () => {
    expect(src).toMatch(/run_failure_analyst\s*\(\)/);
  });

  it('accepts retry_num as 3rd parameter', () => {
    const funcStart = src.indexOf('run_failure_analyst()');
    const funcEnd   = src.indexOf('\n}', funcStart + 50);
    const body      = src.slice(funcStart, funcEnd);
    expect(body).toMatch(/retry_num.*\$\{3/);
  });

  it('is guarded by VERIFICATION_FAILURE — skips when no test output is available', () => {
    expect(src).toContain('[ -z "${VERIFICATION_FAILURE:-}" ] && return 0');
  });

  it('is gated on ORCH_GATE_PROVIDER — skips gracefully when no gate is configured', () => {
    expect(src).toMatch(/\[ -z.*gate_provider.*\].*&&.*return/);
  });
});

// ── 2. Call site in retry loop ────────────────────────────────────────────────
describe('claude.sh — analyst is called before retry_count is incremented', () => {
  it('run_failure_analyst is called inside the retry loop', () => {
    expect(src).toMatch(/run_failure_analyst\s+"\$story_id"/);
  });

  it('call site passes retry_count as 3rd argument', () => {
    expect(src).toMatch(/run_failure_analyst.*\$story_id.*\$output_file.*\$retry_count/);
  });

  it('call to run_failure_analyst comes before retry_count increment', () => {
    const analystIdx = src.indexOf('run_failure_analyst "$story_id"');
    const afterAnalyst = src.slice(analystIdx);
    expect(afterAnalyst).toMatch(/retry_count=\$\(\(\s*retry_count\s*\+\s*1\s*\)\)/);
  });

  it('analyst only runs when more retries remain (retry_count < MAX_RETRIES)', () => {
    // Use indexOf to avoid catastrophic backtracking over large file
    const guardIdx    = src.indexOf('retry_count -lt $MAX_RETRIES');
    const afterGuard  = src.slice(guardIdx, guardIdx + 200);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(afterGuard).toMatch(/run_failure_analyst/);
  });
});

// ── 3. Downstream handoff ─────────────────────────────────────────────────────
describe('claude.sh — failure analysis is handed off to the downstream retry agent', () => {
  it('diagnosis is always injected into COORDINATOR_PROMPT_AMENDMENT', () => {
    expect(src).toMatch(/COORDINATOR_PROMPT_AMENDMENT.*diagnosis|diagnosis.*COORDINATOR_PROMPT_AMENDMENT/is);
  });

  it('Self-Heal marker is present in the injected amendment so it is identifiable in logs', () => {
    expect(src).toMatch(/Self-Heal.*Failure Analyst|FailureAnalyst.*Self-Heal/is);
  });

  it('skill_note is included in the amendment when target=skill', () => {
    expect(src).toMatch(/skill_note.*COORDINATOR_PROMPT_AMENDMENT|COORDINATOR_PROMPT_AMENDMENT.*skill_note/is);
  });
});

// ── 4. Gate model wiring ──────────────────────────────────────────────────────
describe('claude.sh — failure analyst uses the same gate model as coordinator', () => {
  it('calls ai-run.sh with the gate provider from env (not a hardcoded model)', () => {
    expect(src).toMatch(/ai-run\.sh.*gate_provider|gate_provider.*ai-run\.sh/is);
  });

  it('analyst prompt includes current story ACs so the model can diff spec vs result', () => {
    expect(src).toMatch(/story_acs|STORY_ACS|acceptanceCriteria/);
    expect(src).toMatch(/__STORY_ACS__|story_acs.*analyst_prompt|analyst_prompt.*story_acs/is);
  });

  it('analyst prompt includes VERIFICATION_FAILURE test output', () => {
    expect(src).toMatch(/__VERIFICATION_FAILURE__|VERIFICATION_FAILURE.*analyst_prompt|analyst_prompt.*VERIFICATION_FAILURE/is);
  });

  it('analyst prompt includes agent skill addendum from profiles so it can detect bad patterns', () => {
    expect(src).toMatch(/__SKILL_ADDENDUM__|SKILL_ADDENDUM.*analyst_prompt|skill_addendum/is);
  });
});

// ── 5. PRD patching path ──────────────────────────────────────────────────────
describe('claude.sh — PRD AC patches are applied when analyst targets prd', () => {
  it('applies AC patches using python3 to safely mutate prd.json JSON', () => {
    expect(src).toMatch(/python3.*ac_patches|ac_patches.*python3/is);
  });

  it('patch_count is declared at function scope (not only inside case branch)', () => {
    const funcStart = src.indexOf('run_failure_analyst()');
    const funcEnd   = src.indexOf('\n}', funcStart + 50);
    const body      = src.slice(funcStart, funcEnd);
    // patch_count must be declared before the case statement so run_healing_recorder
    // can read it regardless of which target path ran
    const patchDeclIdx = body.indexOf('patch_count=0');
    const caseIdx      = body.indexOf('case "$target"');
    expect(patchDeclIdx).toBeGreaterThan(-1);
    expect(patchDeclIdx).toBeLessThan(caseIdx);
  });

  it('log line shows Applied N AC patch(es) so the operator can see what changed', () => {
    expect(src).toMatch(/Applied.*patch.*AC patch|patch_count.*Applied/is);
  });
});

// ── 6. Profile persistence path ───────────────────────────────────────────────
describe('claude.sh — target=skill persists skill note to profiles.json (not just prompt)', () => {
  it('skill branch reads profiles_file', () => {
    const funcStart = src.indexOf('run_failure_analyst()');
    const funcEnd   = src.indexOf('\n}', funcStart + 50);
    const body      = src.slice(funcStart, funcEnd);
    const skillStart = body.indexOf('skill)');
    const skillEnd   = body.indexOf(';;', skillStart);
    const skillBlock = body.slice(skillStart, skillEnd);
    expect(skillBlock).toMatch(/profiles_file/);
  });

  it('skill branch uses python3 to safely update profiles.json addendum', () => {
    const funcStart  = src.indexOf('run_failure_analyst()');
    const funcEnd    = src.indexOf('\n}', funcStart + 50);
    const body       = src.slice(funcStart, funcEnd);
    const skillStart = body.indexOf('skill)');
    const skillEnd   = body.indexOf(';;', skillStart);
    const skillBlock = body.slice(skillStart, skillEnd);
    expect(skillBlock).toMatch(/python3/);
  });

  it('skill branch sets _profile_updated=true after successful write', () => {
    const funcStart = src.indexOf('run_failure_analyst()');
    const funcEnd   = src.indexOf('\n}', funcStart + 50);
    const body      = src.slice(funcStart, funcEnd);
    expect(body).toMatch(/_profile_updated.*true|_profile_updated="true"/);
  });

  it('_profile_updated is declared at function scope (before case)', () => {
    const funcStart      = src.indexOf('run_failure_analyst()');
    const funcEnd        = src.indexOf('\n}', funcStart + 50);
    const body           = src.slice(funcStart, funcEnd);
    const profileDeclIdx = body.indexOf('_profile_updated');
    const caseIdx        = body.indexOf('case "$target"');
    expect(profileDeclIdx).toBeGreaterThan(-1);
    expect(profileDeclIdx).toBeLessThan(caseIdx);
  });

  it('healing recorder receives _profile_updated so the event log is accurate', () => {
    const funcStart = src.indexOf('run_failure_analyst()');
    const funcEnd   = src.indexOf('\n}', funcStart + 50);
    const body      = src.slice(funcStart, funcEnd);
    expect(body).toMatch(/run_healing_recorder.*_profile_updated|\$_profile_updated/);
  });
});

// ── 7. Healing recorder wiring ────────────────────────────────────────────────
describe('claude.sh — run_healing_recorder is called on every successful analyst cycle', () => {
  it('run_healing_recorder is called inside run_failure_analyst', () => {
    const funcStart = src.indexOf('run_failure_analyst()');
    const funcEnd   = src.indexOf('\n}', funcStart + 50);
    const body      = src.slice(funcStart, funcEnd);
    expect(body).toMatch(/run_healing_recorder/);
  });

  it('recorder call is after the esac block (fires for all target paths)', () => {
    const funcStart   = src.indexOf('run_failure_analyst()');
    const funcEnd     = src.indexOf('\n}', funcStart + 50);
    const body        = src.slice(funcStart, funcEnd);
    const esacIdx     = body.lastIndexOf('esac');
    const recorderIdx = body.indexOf('run_healing_recorder');
    expect(recorderIdx).toBeGreaterThan(esacIdx);
  });
});

// ── 8. Gate model env-clobber protection (run 103 regression guard) ───────────
// Bug: claude.sh called load_env_file() which re-sourced .env with `set -a`,
// overwriting ORCH_GATE_MODEL set by tier3. The failure analyst then called
// ai-run.sh with wrong model, got silent failure, and all retries had no self-healing.
describe('claude.sh — ORCH_GATE_MODEL survives .env reload (run 103 regression guard)', () => {
  it('saves ORCH_GATE_PROVIDER before the load_env_file CALL (not just its definition)', () => {
    const saveIdx = src.indexOf('_claude_pre_gate_provider=');
    const callIdx = src.indexOf('load_env_file "$(');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(callIdx);
  });

  it('saves ORCH_GATE_MODEL before the load_env_file CALL', () => {
    const saveIdx = src.indexOf('_claude_pre_gate_model=');
    const callIdx = src.indexOf('load_env_file "$(');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(callIdx);
  });

  it('restores ORCH_GATE_MODEL after load_env_file', () => {
    // Use indexOf to avoid catastrophic regex backtracking on large file
    const loadIdx    = src.indexOf('load_env_file "$(');
    const restoreStr = '[ -n "$_claude_pre_gate_model"    ] && ORCH_GATE_MODEL="$_claude_pre_gate_model"';
    const restoreIdx = src.indexOf(restoreStr);
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(loadIdx);
  });

  it('unsets _claude_pre_* temp vars after restore', () => {
    expect(src).toContain('unset _claude_pre_gate_provider _claude_pre_gate_model _claude_pre_orch_provider');
  });

  it('gate vars are re-exported after restore so subprocesses inherit correct values', () => {
    const restoreIdx   = src.indexOf('unset _claude_pre_');
    const afterRestore = src.slice(restoreIdx, restoreIdx + 200);
    expect(afterRestore).toMatch(/export.*ORCH_GATE/);
  });

  it('failure analyst gate_model is sourced from ORCH_GATE_MODEL (not hardcoded)', () => {
    const analystStart = src.indexOf('run_failure_analyst()');
    const analystEnd   = src.indexOf('\n}', analystStart + 50);
    const body         = src.slice(analystStart, analystEnd);
    expect(body).toMatch(/gate_model.*ORCH_GATE_MODEL/);
    expect(body).not.toMatch(/qwen3-coder|gpt-4o|MiniMax-M3|claude-haiku/);
  });
});

// ── 9. Mock PRD fixture validates the framework (not the travel app) ──────────
// These tests verify that the mock data used by framework tests is well-formed —
// so integration tests that feed it to bash functions have valid inputs.
describe('mock-prd.json fixture — schema contract for framework testing', () => {
  it('has at least two phases', () => {
    const phases = Object.keys(mockPrd.implementationOrder as Record<string, string[]>);
    expect(phases.length).toBeGreaterThanOrEqual(2);
  });

  it('every story referenced in implementationOrder exists in stories array', () => {
    const byId = new Set(mockPrd.stories.map((s: any) => s.id));
    const refs = Object.values(mockPrd.implementationOrder as Record<string, string[]>).flat();
    for (const id of refs) {
      expect(byId.has(id), `implementationOrder references ${id} but it is not in stories`).toBe(true);
    }
  });

  it('every story has at least one acceptanceCriteria entry', () => {
    for (const story of mockPrd.stories) {
      expect(
        (story.acceptanceCriteria as string[]).length,
        `Story ${story.id} has no ACs — framework tests need at least one`
      ).toBeGreaterThan(0);
    }
  });

  it('every story has an agentProfile field (required by failure analyst)', () => {
    for (const story of mockPrd.stories) {
      expect(story.agentProfile, `Story ${story.id} missing agentProfile`).toBeTruthy();
    }
  });
});

// ── 10. Mock profiles fixture validates the framework ─────────────────────────
describe('mock-profiles.json fixture — schema contract for framework testing', () => {
  it('has a profiles object at root', () => {
    expect(mockProfiles.profiles).toBeTruthy();
    expect(typeof mockProfiles.profiles).toBe('object');
  });

  it('each profile has an addendum field (target for skill note persistence)', () => {
    for (const [role, profile] of Object.entries(mockProfiles.profiles as Record<string, any>)) {
      expect(
        typeof profile.addendum,
        `Profile [${role}] missing addendum field`
      ).toBe('string');
    }
  });
});
