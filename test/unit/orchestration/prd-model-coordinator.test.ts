/**
 * PRD Model Coordinator — a new agent that guarantees every pending story
 * (base and split children created by the spec pass) carries explicit
 * model / aiProvider / reasoningEffort fields in the PRD before execution.
 *
 * Root cause this closes: SKY-001-A (a spec-pass split child) had no .model
 * field, so it silently fell back to MiniMaxProvider's hardcoded default
 * ('MiniMax-M2.5') instead of the intended MiniMax-M3. The PRD — not env
 * vars, not provider defaults — must be the single source of truth for
 * per-story model assignment.
 *
 * Tests cover:
 *   A. Profile existence + content (assignment rules, allow-list, output schema)
 *   B. prd-change-reviewer extended with model_assignment rules
 *   C. Step 0.9 wiring in run-agent-orchestration.sh (ordering, skip flag,
 *      reviewer gate, revert-on-fail, fallback safety net)
 *   D. claude.sh — resolve_reasoning_effort_from_story wiring
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PROFILES  = path.join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const PROFILES_ORIG = path.join(REPO_ROOT, 'orchestrations/agents/profiles.json.original');
const ORCH      = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = path.join(REPO_ROOT, 'orchestrations/scripts/claude.sh');

const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const profilesOrig = JSON.parse(fs.readFileSync(PROFILES_ORIG, 'utf8'));
const agent: string = profiles['prd-model-coordinator'];
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const claudeSrc = fs.readFileSync(CLAUDE_SH, 'utf8');

// ── A. Profile existence + content ───────────────────────────────────────────

describe('prd-model-coordinator — profile existence', () => {
  it('profile key exists in profiles.json', () => {
    expect(profiles['prd-model-coordinator']).toBeTruthy();
    expect(typeof profiles['prd-model-coordinator']).toBe('string');
  });

  it('profile key also exists in profiles.json.original (canonical floor)', () => {
    expect(profilesOrig['prd-model-coordinator']).toBeTruthy();
    expect(profilesOrig['prd-model-coordinator']).toBe(agent);
  });

  it('profile is non-trivially long (meaningful contract, not a stub)', () => {
    expect(agent.length).toBeGreaterThan(300);
  });

  it('profiles.json and profiles.json.original have the same key count', () => {
    expect(Object.keys(profiles).length).toBe(Object.keys(profilesOrig).length);
  });
});

describe('prd-model-coordinator — input contract', () => {
  it('runs after spec pass has created split children', () => {
    expect(agent).toMatch(/split children|spec.*pass.*elaborated/i);
  });

  it('expects PRD file path and phase name as input', () => {
    expect(agent).toMatch(/PRD file/i);
    expect(agent).toMatch(/phase/i);
  });

  it('scopes to pending stories only', () => {
    expect(agent).toMatch(/pending/i);
  });
});

describe('prd-model-coordinator — assignment rules', () => {
  it('never overwrites a story that already has all three fields set', () => {
    expect(agent).toMatch(/already has model.*leave.*untouched|never overwrite/i);
  });

  it('split children inherit model/aiProvider/reasoningEffort from parent via createdFrom', () => {
    expect(agent).toMatch(/createdFrom/);
    expect(agent).toMatch(/inherit/i);
  });

  it('defines a fallback default when no inheritance is possible', () => {
    expect(agent).toMatch(/MiniMax-M3/);
    expect(agent).toMatch(/minimax/);
  });

  it('maps story effort field to reasoningEffort default (low/high/medium)', () => {
    expect(agent).toMatch(/effort=low.*reasoningEffort=low|low.*->.*low/i);
    expect(agent).toMatch(/effort=high.*reasoningEffort=high|high.*->.*high/i);
  });

  it('constrains model/provider assignments to an explicit allow-list (no hallucinated models)', () => {
    expect(agent).toMatch(/Never invent a model or provider/i);
    expect(agent).toMatch(/MiniMax-M3.*MiniMax-M2\.5|kimi-k2|glm-5\.2/);
  });

  it('forbids touching any field other than model/aiProvider/reasoningEffort', () => {
    expect(agent).toMatch(/Never change a story's effort, acceptanceCriteria|only.*model.*aiProvider.*reasoningEffort/i);
  });

  it('requires atomic whole-document read-modify-write (not partial patches)', () => {
    expect(agent).toMatch(/atomically|read-modify-write/i);
  });
});

describe('prd-model-coordinator — output schema', () => {
  it('emits "assigned_count" field', () => {
    expect(agent).toMatch(/"assigned_count"/);
  });

  it('emits "stories" array of affected IDs', () => {
    expect(agent).toMatch(/"stories"/);
  });

  it('emits a reason field capped in length', () => {
    expect(agent).toMatch(/"reason"/);
    expect(agent).toMatch(/15 words max/i);
  });
});

// ── B. prd-change-reviewer extended for model_assignment ────────────────────

describe('prd-change-reviewer — model_assignment change type coverage', () => {
  const reviewer: string = profiles['prd-change-reviewer'];

  it('reviewer profile documents model_assignment as a recognized change type', () => {
    expect(reviewer).toMatch(/model_assignment/);
  });

  it('rejects overwriting a pre-existing model/aiProvider/reasoningEffort value', () => {
    expect(reviewer).toMatch(/PRE-EXISTING model.*changed or removed|coordinator must only fill gaps/i);
  });

  // REMOVED 2026-07-29 (STACK-1): the reviewer no longer enumerates permitted
  // models or providers. Those come from EPAM_MODEL_LADDER_* and
  // EPAM_FINAL_FALLBACK_MODEL, which are per-project config — policing them
  // from a prompt silently vetoed what the project had configured.
  // moonshotai/kimi-k3 is the configured top of the HIGH ladder and this rule
  // would have rejected it on arrival, so kimi was unreachable twice over.
  //
  // The invariant those rules were really protecting is asserted below and is
  // unchanged: the coordinator fills gaps, it never overwrites.
  it('still forbids overwriting a pre-existing assignment', () => {
    expect(reviewer, 'the coordinator could now overwrite a deliberate model choice')
      .toMatch(/coordinator must only fill gaps, never overwrite/i);
  });

  it('rejects split-child model mismatches with their parent', () => {
    expect(reviewer).toMatch(/split child.*model.*aiProvider.*match its parent|createdFrom.*values/i);
  });

  it('is present identically in profiles.json.original', () => {
    expect(profilesOrig['prd-change-reviewer']).toBe(reviewer);
  });
});

// ── C. Step 0.9 wiring in run-agent-orchestration.sh ─────────────────────────

describe('run-agent-orchestration.sh — Step 0.9 wiring', () => {
  it('Step 0.9 label appears in the script', () => {
    expect(orchSrc).toMatch(/Step 0\.9: PRD model coordinator/);
  });

  it('Step 0.9 is registered in the step-status JSON emitter key list', () => {
    expect(orchSrc).toMatch(/"7:model-coord"/);
  });

  it('Step 0.9 appears in the checklist printer', () => {
    expect(orchSrc).toMatch(/_checklist_row "7"\s+"PRD model coordinator"/);
  });

  it('Step 0.9 runs after Step 0.8 (mkdir) and before Step 1 (main-branch stories) in file order', () => {
    const idx08 = orchSrc.indexOf('step_emit "6" "pass"');
    const idx09 = orchSrc.indexOf('step_emit "7" "running"');
    const idx1 = orchSrc.indexOf('Step 1: Run main-branch stories');
    expect(idx08).toBeGreaterThan(-1);
    expect(idx09).toBeGreaterThan(idx08);
    expect(idx1).toBeGreaterThan(idx09);
  });

  it('is gated by SKIP_PRD_MODEL_COORDINATOR env var', () => {
    expect(orchSrc).toMatch(/SKIP_PRD_MODEL_COORDINATOR/);
  });

  it('skips the LLM call entirely when no pending story is missing a field', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/_mc_missing_count.*-eq 0/s);
  });

  it('reads prd-model-coordinator profile from profiles.json (AUTOMATION_DIR, not SCRIPT_DIR)', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/prd-model-coordinator/);
    // RESOLUTION POINT CHANGED 2026-08-08: the agents directory is resolved once, via
    // EPAM_AGENTS_DIR defaulting to $AUTOMATION_DIR/agents, so a run keeping its artefacts
    // elsewhere does not read and write the live roster. Unset, the path is identical to
    // before — the concern here is unchanged: it must not resolve from SCRIPT_DIR.
    expect(block).toMatch(/EPAM_AGENTS_DIR:-\$\{?AUTOMATION_DIR\}?\/agents/);
    expect(block).not.toMatch(/SCRIPT_DIR.*profiles\.json/);
  });

  it('grants tool access via AI_GATE_ALLOW_TOOLS=1 (agent must write PRD directly)', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/AI_GATE_ALLOW_TOOLS=1/);
  });

  it('snapshots PRD before the coordinator writes, for revert-on-fail', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/_mc_prd_before=/);
  });

  // The reviewer gate USED to be an LLM call fed a BEFORE/AFTER excerpt
  // truncated to the last 1000 characters of the PRD — for any real multi-KB
  // PRD, structurally blind to a change anywhere earlier in the file. Root
  // cause of a live-run defect (2026-07-08/09): the coordinator silently
  // stripped technicalNotes.files from SKY-002/003/004 while that excerpt-
  // based reviewer saw nothing wrong. "Only model/aiProvider/reasoningEffort
  // may change" is a 100% mechanically checkable invariant, so it's now a
  // deterministic full-file, every-story, every-field diff in Python instead
  // of an LLM judgment call on a truncated excerpt.
  it('the reviewer gate is a deterministic Python diff, not a truncated-excerpt LLM call', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).not.toMatch(/last 1000 chars/);
    expect(block).not.toMatch(/CHANGE TYPE: model_assignment/);
    expect(block).toMatch(/ALLOWED_FIELDS = \{'model', 'aiProvider', 'reasoningEffort'\}/);
  });

  it('the deterministic diff compares every story by ID, not a truncated text excerpt', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/before_by_id = \{s\['id'\]: s for s in before\.get\('stories', \[\]\)/);
    expect(block).toMatch(/after_by_id = \{s\['id'\]: s for s in after\.get\('stories', \[\]\)/);
  });

  it('flags added/removed stories and implementationOrder changes as violations too, not just field changes', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/stories added:/);
    expect(block).toMatch(/stories removed:/);
    expect(block).toMatch(/implementationOrder was modified/);
  });

  it('reverts the PRD to the snapshot when the reviewer verdict is fail', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 9000);
    expect(block).toMatch(/REJECTED by reviewer.*reverting PRD/is);
    expect(block).toMatch(/echo "\$_mc_prd_before" > "\$_mc_prd_target"/);
  });

  it('has a post-condition Python fallback that fills any still-missing field', () => {
    // Widened 10000 -> 11000 -> 12000 (2026-07-13): the violationTypes
    // derivation + _log_guarded_step_retry call added around the coordinator
    // call pushed this fallback section further from the anchor.
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 12000);
    expect(block).toMatch(/Post-condition safety net/i);
    expect(block).toMatch(/s\['model'\] = 'MiniMax-M3'/);
    expect(block).toMatch(/s\['aiProvider'\] = 'minimax'/);
    expect(block).toMatch(/s\['reasoningEffort'\]/);
  });

  it('fallback only touches pending stories in the current phase', () => {
    const idx = orchSrc.indexOf('Step 0.9: PRD model coordinator');
    const block = orchSrc.slice(idx, idx + 12000);
    expect(block).toMatch(/status'\) != 'pending'/);
    expect(block).toMatch(/get\('phase', phase\) != phase/);
  });
});

// ── D. claude.sh — reasoningEffort consumption ───────────────────────────────

describe('claude.sh — resolve_reasoning_effort_from_story wiring', () => {
  it('defines resolve_reasoning_effort_from_story as a shell function', () => {
    expect(claudeSrc).toMatch(/resolve_reasoning_effort_from_story\s*\(\)/);
  });

  it('reads .reasoningEffort field from the PRD story', () => {
    const idx = claudeSrc.indexOf('resolve_reasoning_effort_from_story()');
    const block = claudeSrc.slice(idx, idx + 1300);
    expect(block).toMatch(/\.reasoningEffort/);
  });

  it('overrides EPAM_REASONING_EFFORT only when the field is present (does not clear it)', () => {
    const idx = claudeSrc.indexOf('resolve_reasoning_effort_from_story()');
    const block = claudeSrc.slice(idx, idx + 1300);
    expect(block).toMatch(/if \[ -n "\$story_effort" \]/);
    expect(block).toMatch(/export EPAM_REASONING_EFFORT="\$story_effort"/);
  });

  it('is called after the "low" reset at story start, so PRD value wins', () => {
    // Rung 0's reset is now env-overridable (EPAM_RUNG0_REASONING_EFFORT,
    // default "low") — still a literal "low" default, just wrapped.
    const resetIdx = claudeSrc.indexOf('export EPAM_REASONING_EFFORT="${EPAM_RUNG0_REASONING_EFFORT:-low}"');
    const callIdx = claudeSrc.indexOf('resolve_reasoning_effort_from_story "$story_id"');
    expect(resetIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(resetIdx);
  });
});
