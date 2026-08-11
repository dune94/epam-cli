/**
 * Agent profile wiring tests.
 *
 * Verifies that every agent with a profile in profiles.json is:
 *   1. Defined with a meaningful profile (not a stub)
 *   2. Wired into its driving script (reads from profiles.json, not hardcoded)
 *
 * Covered agents: failure-analyst, tc-writer-agent, spec-coordinator-agent
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineAndPrompt } from '../../helpers/analyst-prompt';

const REPO = join(__dirname, '../../../');
const PROFILES_FILE    = join(REPO, 'orchestrations/agents/profiles.json');
const CLAUDE_SH        = join(REPO, 'orchestrations/scripts/claude.sh');
const TC_WRITER_SH     = join(REPO, 'orchestrations/scripts/post-impl-tc-writer.sh');
const SPEC_RUNNER_JS   = join(REPO, 'orchestrations/scripts/spec-mode-runner.js');

const profiles = JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
const claudeSrc    = engineAndPrompt(readFileSync(CLAUDE_SH, 'utf8'));
const tcWriterSrc  = readFileSync(TC_WRITER_SH, 'utf8');
const specRunnerSrc = readFileSync(SPEC_RUNNER_JS, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// failure-analyst
// ─────────────────────────────────────────────────────────────────────────────

describe('failure-analyst — profile and wiring', () => {
  const agent: string = profiles['failure-analyst'] ?? '';

  it('profile key exists in profiles.json', () => {
    expect(profiles['failure-analyst']).toBeTruthy();
    expect(typeof profiles['failure-analyst']).toBe('string');
  });

  it('profile is non-trivially long (not a stub)', () => {
    expect(agent.length).toBeGreaterThan(400);
  });

  it('profile declares the agent role (failure analyst)', () => {
    expect(agent).toMatch(/failure analyst|self-healing/i);
  });

  it('profile lists at least 3 known failure patterns (domain knowledge)', () => {
    // Each pattern keyword represents a separate known failure
    const patterns = [
      /vitest.*No test files|No test files.*vitest/i,
      /IPv6|::|127\.0\.0\.1/i,
      /supertest/i,
    ];
    for (const p of patterns) {
      expect(agent, `Profile missing pattern: ${p}`).toMatch(p);
    }
  });

  it('profile declares all valid target values (prd, tc, skill, kb, none)', () => {
    expect(agent).toMatch(/target=prd/);
    expect(agent).toMatch(/target=tc/);
    expect(agent).toMatch(/target=skill/);
    expect(agent).toMatch(/target=kb/);
    expect(agent).toMatch(/target=none/);
  });

  it('profile specifies compact JSON output format', () => {
    expect(agent).toMatch(/diagnosis|target|skill_note|reason/i);
  });

  it('claude.sh reads failure-analyst profile from profiles.json', () => {
    // Must read the profile key by name
    expect(claudeSrc).toMatch(/failure-analyst/);
    expect(claudeSrc).toMatch(/jq.*failure-analyst|failure-analyst.*jq/i);
  });

  it('claude.sh uses __ANALYST_PROFILE__ placeholder in the prompt heredoc', () => {
    expect(claudeSrc).toContain('__ANALYST_PROFILE__');
  });

  it('__ANALYST_PROFILE__ is supplied as a render value before sending to LLM', () => {
    // Substitution moved out of the engine on 2026-08-11. It used to be a bash
    // `${analyst_prompt//__ANALYST_PROFILE__/...}` expansion; the prompt now lives in a
    // project-authority JSON file and lib/prompt-library.js renders it. The library REFUSES
    // to emit a prompt with any placeholder left unresolved, which is a stronger guarantee
    // than this test ever made — a missed substitution used to sail through as literal text.
    const i = claudeSrc.indexOf('"__ANALYST_PROFILE__":$profile');
    expect(i, 'the profile is no longer passed to the renderer').toBeGreaterThan(-1);
    expect(claudeSrc).toContain('prompt-library.js');
  });

  it('claude.sh has a fallback when profile is empty', () => {
    // Must not crash when profiles.json missing or key absent
    expect(claudeSrc).toMatch(/\[\s*-z.*analyst_profile.*\].*&&.*analyst_profile=/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tc-writer-agent
// ─────────────────────────────────────────────────────────────────────────────

describe('tc-writer-agent — profile and wiring', () => {
  const agent: string = profiles['tc-writer-agent'] ?? '';

  it('profile key exists in profiles.json', () => {
    expect(profiles['tc-writer-agent']).toBeTruthy();
    expect(typeof profiles['tc-writer-agent']).toBe('string');
  });

  it('profile is non-trivially long (not a stub)', () => {
    expect(agent.length).toBeGreaterThan(200);
  });

  it('profile defines the TC writer role', () => {
    expect(agent).toMatch(/TC.*writer|test criteria/i);
  });

  it('profile specifies testCriteria JSON as the output', () => {
    expect(agent).toMatch(/testCriteria|test.*criteria.*JSON/i);
  });

  it('profile prohibits writing test files (TC writer generates specs, not tests)', () => {
    expect(agent).toMatch(/do NOT write test files|does not write.*test/i);
  });

  it('post-impl-tc-writer.sh loads the profile from profiles.json', () => {
    expect(tcWriterSrc).toMatch(/PROFILES_FILE/);
    expect(tcWriterSrc).toMatch(/tc-writer-agent/);
    expect(tcWriterSrc).toMatch(/jq.*tc-writer-agent/);
  });

  it('post-impl-tc-writer.sh injects the profile into TC_PROMPT via variable substitution', () => {
    expect(tcWriterSrc).toMatch(/TC_WRITER_PROFILE/);
    expect(tcWriterSrc).toContain('${TC_WRITER_PROFILE}');
  });

  it('post-impl-tc-writer.sh has a fallback when profile is empty', () => {
    expect(tcWriterSrc).toMatch(/TC_WRITER_PROFILE.*You are the TC writer/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// spec-coordinator-agent
// ─────────────────────────────────────────────────────────────────────────────

describe('spec-coordinator-agent — profile and wiring', () => {
  const agent: string = profiles['spec-coordinator-agent'] ?? '';

  it('profile key exists in profiles.json', () => {
    expect(profiles['spec-coordinator-agent']).toBeTruthy();
    expect(typeof profiles['spec-coordinator-agent']).toBe('string');
  });

  it('profile is non-trivially long (not a stub)', () => {
    expect(agent.length).toBeGreaterThan(200);
  });

  it('profile defines coordinator role (assigns spec agents per story)', () => {
    expect(agent).toMatch(/coordinator|assigns.*agent|specification/i);
  });

  it('profile references the PRD and implementationOrder', () => {
    expect(agent).toMatch(/prd\.json|implementationOrder/i);
  });

  it('spec-mode-runner.js loads profiles.json at startup', () => {
    expect(specRunnerSrc).toMatch(/profiles\.json/);
    expect(specRunnerSrc).toMatch(/JSON\.parse.*readFileSync.*profiles|readFileSync.*profiles.*JSON\.parse/s);
  });

  it('spec-mode-runner.js extracts spec-coordinator-agent profile', () => {
    expect(specRunnerSrc).toMatch(/spec-coordinator-agent/);
    expect(specRunnerSrc).toMatch(/profiles\[.?spec-coordinator-agent.?\]/);
  });

  it('spec-mode-runner.js prepends profile to coordinator assignment prompt', () => {
    const assignIdx = specRunnerSrc.indexOf('coordinatorPrompt');
    expect(assignIdx).toBeGreaterThan(-1);
    const block = specRunnerSrc.slice(assignIdx, assignIdx + 300);
    expect(block).toMatch(/specCoordinatorProfile/);
  });

  it('spec-mode-runner.js prepends profile to coordinator review prompt', () => {
    const reviewIdx = specRunnerSrc.indexOf('reviewPrompt');
    expect(reviewIdx).toBeGreaterThan(-1);
    const block = specRunnerSrc.slice(reviewIdx, reviewIdx + 300);
    expect(block).toMatch(/specCoordinatorProfile/);
  });

  it('spec-mode-runner.js prepends profile to model assignment prompt', () => {
    const modelIdx = specRunnerSrc.indexOf('modelReviewPrompt');
    expect(modelIdx).toBeGreaterThan(-1);
    const block = specRunnerSrc.slice(modelIdx, modelIdx + 300);
    expect(block).toMatch(/specCoordinatorProfile/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// review-agent (team-lead-review.sh / code-review-cycle.sh)
// ─────────────────────────────────────────────────────────────────────────────

describe('review-agent — profile and wiring', () => {
  const TEAM_LEAD_SH = join(REPO, 'orchestrations/scripts/team-lead-review.sh');
  const CODE_REVIEW_SH = join(REPO, 'orchestrations/scripts/code-review-cycle.sh');
  const teamLeadSrc  = readFileSync(TEAM_LEAD_SH, 'utf8');
  const codeReviewSrc = readFileSync(CODE_REVIEW_SH, 'utf8');

  const agent: string = profiles['review-agent'] ?? '';

  it('profile key exists in profiles.json', () => {
    expect(profiles['review-agent']).toBeTruthy();
    expect(typeof profiles['review-agent']).toBe('string');
  });

  it('profile is non-trivially long (not a stub)', () => {
    expect(agent.length).toBeGreaterThan(100);
  });

  it('team-lead-review.sh reads review-agent profile from profiles.json', () => {
    expect(teamLeadSrc).toMatch(/AGENT_PROFILES_FILE/);
    expect(teamLeadSrc).toMatch(/review-agent/);
  });

  it('code-review-cycle.sh reads review-agent profile from profiles.json', () => {
    expect(codeReviewSrc).toMatch(/AGENT_PROFILES_FILE/);
    expect(codeReviewSrc).toMatch(/review-agent/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No OpenAI fallback defaults in gate calls
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAI leak prevention — gate defaults are minimax, not openai', () => {
  const ORCH_SH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');
  const orchSrc = readFileSync(ORCH_SH, 'utf8');

  it('run-agent-orchestration.sh default gate provider is minimax (not openai)', () => {
    // No :-openai default should remain anywhere
    expect(orchSrc).not.toMatch(/ORCH_GATE_PROVIDER:-openai/);
  });

  it('run-agent-orchestration.sh default gate model is MiniMax-M3 (not gpt-4o)', () => {
    expect(orchSrc).not.toMatch(/ORCH_GATE_MODEL:-gpt-4o/);
  });

  it('run-agent-orchestration.sh story model fallback is MiniMax-M3 (not openai/gpt-4.1)', () => {
    expect(orchSrc).not.toMatch(/"openai\/gpt-4\.1"/);
  });

  it('contextualize-stories.sh does not enable OpenAI semantic search', () => {
    const contextSrc = readFileSync(
      join(REPO, 'orchestrations/scripts/contextualize-stories.sh'),
      'utf8'
    );
    expect(contextSrc).not.toMatch(/USE_SEMANTIC_RAG=true/);
    expect(contextSrc).not.toMatch(/OPENAI_KEY_FOR_RAG/);
  });
});
