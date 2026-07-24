/**
 * B19 — the skill-assessment step told an LLM to fetch its own inputs.
 *
 * The prompt was a ~2,770-token instruction manual handing over PATHS and telling
 * the model to go get the data with 13 shell commands:
 *
 *   1. Run: jq -r '.implementationOrder["core"][]' <prd>
 *   2. For each story ID, run: jq -c --arg id "<id>" '.stories[] | select(...)' <prd>
 *      a. Read the current list of source files: find . -name "*.ts" ...
 *
 * The orchestrator already runs those exact queries ~70 times elsewhere in the same
 * file. Every instructed command costs a full round-trip (emit tool call -> execute
 * -> re-send the whole conversation to interpret), and the conversation is re-paid
 * each step: input grew 3,483 -> 15,985 tokens across iterations.
 *
 * Measured cost for a ONE-LINE story (mock1, 2026-07-24): 48 LLM calls, 432K input
 * tokens, 224-282s — a quarter of the run, before implementation starts.
 *
 * It also TAUGHT the `find`: line "a. Read the current list of source files:
 * find . -name ..." is why the agent reached for `find /` when a file was not where
 * it expected, hanging the pipeline for 282 seconds.
 *
 * Every comparable agent already interpolates DATA rather than paths — claude.sh
 * impl has 26 such interpolations, the repro-test-writer 7, spec-mode builds a full
 * storyPayload. This step was the outlier.
 *
 * Fix: the orchestrator computes the data (it has it) and interpolates it. The model
 * is left only the part that needs judgement — role assignment and gap inference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

function assessmentBlock(): string {
  const i = ORCH.indexOf('run_pre_phase_assessment() {');
  expect(i, 'run_pre_phase_assessment not found').toBeGreaterThan(-1);
  return ORCH.slice(i, i + 20000);
}
function prompt(): string {
  const i = ORCH.indexOf('You are the skill assessment agent running in PRE-PHASE mode');
  expect(i).toBeGreaterThan(-1);
  return ORCH.slice(i, i + 8000);
}

describe('B19 — assessment gets DATA, not instructions to fetch data', () => {
  it('the orchestrator computes the story data itself before prompting', () => {
    const b = assessmentBlock();
    // it must build the payload with jq, the way it already does ~70x elsewhere
    expect(b).toMatch(/_pfa_stories_json=|_pfa_story_data=/);
  });

  it('the story data is INTERPOLATED into the prompt', () => {
    expect(prompt()).toMatch(/\$\{_pfa_stories_json\}|\$\{_pfa_story_data\}/);
  });

  it('the existing profile ROLES are interpolated (no need to read profiles.json)', () => {
    expect(prompt()).toMatch(/\$\{_pfa_profile_roles\}/);
  });

  it('no longer instructs the model to run jq', () => {
    expect(prompt()).not.toMatch(/Run: jq|run: jq -c/);
  });

  it('no longer teaches the model to use find (origin of the 282s find / hang)', () => {
    expect(prompt()).not.toMatch(/find \. -name/);
  });

  it('the prompt got materially smaller (it was ~11,000 chars of instructions)', () => {
    // Data interpolation replaces pages of fetch instructions.
    const instructionsOnly = prompt().split('=== ')[0];
    expect(instructionsOnly.length).toBeLessThan(9000);
  });

  it('still asks for the JUDGEMENT parts — role assignment and gap inference', () => {
    const p = prompt();
    expect(p).toMatch(/ROLE ASSIGNMENT/);
    expect(p).toMatch(/SKILL INFERENCE|SKILL GAP/);
  });

  it('remains write-scoped to profiles + PRD', () => {
    expect(assessmentBlock()).toMatch(/EPAM_ALLOWED_WRITE_PATHS="\$\{PROFILES_REL:?-?\},\$\{PRD_REL:?-?\}"/);
  });
});

describe('B19 — no shell-fetch instructions survive anywhere in the prompt', () => {
  it('instructs no jq, find, grep or cat', () => {
    const p = prompt();
    for (const cmd of [/\bjq /, /\bfind /, /\bgrep /, /\bcat /]) {
      expect(p, `prompt still instructs ${cmd}`).not.toMatch(cmd);
    }
  });

  it('exported symbols are interpolated, not grepped by the model', () => {
    expect(assessmentBlock()).toMatch(/_pfa_exports=/);
    expect(prompt()).toMatch(/\$\{_pfa_exports\}/);
  });

  it('the exports extraction is BOUNDED so a large codeline cannot blow up the prompt', () => {
    const b = assessmentBlock();
    const i = b.indexOf('_pfa_exports=');
    expect(b.slice(i, i + 400)).toMatch(/head -\d+/);
  });

  it('explicitly forbids fetching, so the model does not improvise a shell command', () => {
    // The old prompt TAUGHT `find`; silence alone invited improvisation.
    expect(prompt()).toMatch(/Do NOT run jq[\s\S]{0,120}do NOT go looking for files/);
  });
});

/**
 * QUALITY GUARD. Interpolating data instead of letting the agent fetch is only safe
 * if it still RECEIVES everything it needs to judge. The first version of this change
 * handed over role NAMES only (1,001 chars) while the profile CONTENT it is meant to
 * augment is ~146,000 chars — the agent could not have answered "is this skill already
 * covered?" or honoured "only ADD to existing profile strings". That was a real
 * quality regression introduced by the cost fix, caught by asking the question rather
 * than by a test. These assertions stop it recurring.
 */
describe('B19 — the cost fix must not degrade assessment QUALITY', () => {
  it('interpolates the CONTENT of the profiles being augmented, not just their names', () => {
    expect(assessmentBlock()).toMatch(/_pfa_profiles_content=/);
    expect(prompt()).toMatch(/\$\{_pfa_profiles_content\}/);
  });

  it('sends only the roles this phase uses (full profiles.json is ~146KB / ~36K tokens)', () => {
    const b = assessmentBlock();
    expect(b).toMatch(/_pfa_relevant_roles=/);
    expect(b).toMatch(/\[\.\[\]\.agentRole \/\/ empty\] \| unique/);
  });

  it('degrades gracefully when a role has no existing profile (it must create one)', () => {
    expect(assessmentBlock()).toMatch(/no existing profile/);
  });

  it('still supplies acceptanceCriteria + technicalNotes — the basis for gap inference', () => {
    // Step 5 reasons about "the code the agent will write"; stripping these would
    // leave it inferring from role names.
    const b = assessmentBlock();
    expect(b).toMatch(/technicalNotes/);
    expect(b).toMatch(/acceptanceCriteria/);
  });

  it('tells the agent the interpolated profile content is what it is augmenting', () => {
    expect(prompt()).toMatch(/Do NOT re-add a skill already stated here/);
  });
});
