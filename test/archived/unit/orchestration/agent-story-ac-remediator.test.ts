/**
 * Contract tests for the story-ac-remediator agent profile.
 *
 * Agent 2 in the self-healing pipeline. Receives the JSON finding from
 * gate-finding-analyst and augments the owning story's ACs in the PRD.
 * Tests verify the input/output contract, AC quality constraints, idempotency,
 * and wiring in the orch script.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PROFILES  = path.join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const ORCH      = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const agent: string = profiles['story-ac-remediator'];
const orchSrc = fs.readFileSync(ORCH, 'utf8');

// ── Profile existence ────────────────────────────────────────────────────────

describe('story-ac-remediator — profile existence', () => {
  it('profile key exists in profiles.json', () => {
    expect(profiles['story-ac-remediator']).toBeTruthy();
    expect(typeof profiles['story-ac-remediator']).toBe('string');
  });

  it('profile is non-trivially long (meaningful contract, not a stub)', () => {
    expect(agent.length).toBeGreaterThan(300);
  });
});

// ── Input contract ────────────────────────────────────────────────────────────

describe('story-ac-remediator — input contract', () => {
  it('expects a structured gate finding JSON (from gate-finding-analyst)', () => {
    expect(agent).toMatch(/gate-finding-analyst|gate finding/i);
  });

  it('expects the story\'s existing ACs given inline in the prompt (not a PRD file path — the agent has no file access)', () => {
    expect(agent).toMatch(/existing acceptanceCriteria/i);
  });

  it('expects a story_id to locate the target story', () => {
    expect(agent).toMatch(/story_id|story id/i);
  });
});

// ── Idempotency — skip if already covered ────────────────────────────────────

describe('story-ac-remediator — idempotency', () => {
  it('reads existing ACs before adding new ones', () => {
    expect(agent).toMatch(/existing.*acceptanceCriteria|acceptanceCriteria.*existing/i);
  });

  it('skips and returns acs_added: 0 if the pattern is already covered', () => {
    expect(agent).toMatch(/already.*cover|already.*present/i);
    expect(agent).toMatch(/"acs_added".*0|0.*"acs_added"/i);
  });

  it('does not duplicate any existing AC', () => {
    expect(agent).toMatch(/Do NOT duplicate|not.*duplicate/i);
  });
});

// ── AC quality constraints ────────────────────────────────────────────────────

describe('story-ac-remediator — AC quality constraints', () => {
  it('adds at most 2 ACs per call', () => {
    expect(agent).toMatch(/at most 2/i);
  });

  it('requires ACs to be prohibition-style (MUST NOT)', () => {
    expect(agent).toMatch(/MUST NOT|prohibition.style|prohibition/i);
  });

  it('requires ACs to be machine-verifiable with grep or node one-liner', () => {
    expect(agent).toMatch(/machine.verifiable|grep.*one.liner|node.*one.liner/i);
  });

  it('requires ACs to reference the specific rule id from the finding', () => {
    expect(agent).toMatch(/rule id|rule.*finding/i);
  });

  it('requires ACs to name the file or pattern explicitly (not generically)', () => {
    expect(agent).toMatch(/explicitly|not.*generically|specific.*file/i);
  });
});

// ── Write-back contract ───────────────────────────────────────────────────────

describe('story-ac-remediator — write-back contract', () => {
  // The write-back itself is now the ORCHESTRATOR's job, applied
  // deterministically from the agent's JSON output — not the agent's own
  // responsibility (fixed 2026-07-11: the agent narrating "I wrote the PRD"
  // in its text response is not the same as it having actually called a
  // write tool; the live PRD was never updated despite the agent claiming
  // it was). The agent's profile now explicitly says it has no write access.
  it('the agent profile explicitly disclaims file write access', () => {
    expect(agent).toMatch(/NO file write access/i);
  });

  it('the orch script AC-apply logic appends to acceptanceCriteria (does not replace it)', () => {
    const applyIdx = orchSrc.indexOf('AC_APPLY_PY');
    const block = orchSrc.slice(applyIdx, applyIdx + 2200);
    expect(block).toMatch(/setdefault\('acceptanceCriteria', \[\]\)\.append/);
  });

  it('the orch script writes the updated PRD back to disk', () => {
    const applyIdx = orchSrc.indexOf('AC_APPLY_PY');
    const block = orchSrc.slice(applyIdx, applyIdx + 2200);
    expect(block).toMatch(/json\.dump\(prd, f/);
  });

  it('the orch script AC-apply logic does not modify any other story field', () => {
    const applyIdx = orchSrc.indexOf('AC_APPLY_PY');
    const block = orchSrc.slice(applyIdx, applyIdx + 2200);
    // Only ever mutates s['acceptanceCriteria'] on the matched story — no
    // other key assignment appears in the apply loop.
    expect(block).not.toMatch(/s\[['"](?!acceptanceCriteria)\w+['"]\]\s*=/);
  });
});

// ── Output schema ─────────────────────────────────────────────────────────────

describe('story-ac-remediator — output schema', () => {
  it('emits story_id in JSON output', () => {
    expect(agent).toMatch(/"story_id"/);
  });

  it('emits acs_added count', () => {
    expect(agent).toMatch(/"acs_added"/);
  });

  it('emits acs array with the new AC text', () => {
    expect(agent).toMatch(/"acs"/);
  });
});

// ── Wiring in orch script ─────────────────────────────────────────────────────

describe('story-ac-remediator — orch script wiring', () => {
  it('orch script labels Agent 2 log output with [story-ac-remediator]', () => {
    expect(orchSrc).toMatch(/\[story-ac-remediator\]/);
  });

  it('orch script only calls Agent 2 after Agent 1 returned a valid story_id', () => {
    const analyst = orchSrc.indexOf('[gate-finding-analyst]');
    const remediator = orchSrc.indexOf('[story-ac-remediator]');
    // story-ac-remediator must appear AFTER gate-finding-analyst in the script
    expect(remediator).toBeGreaterThan(analyst);
    // The story_id guard must appear between the two
    const between = orchSrc.slice(analyst, remediator);
    expect(between).toMatch(/_story_id/);
  });

  it('orch script passes the finding JSON and PRD_FILE to Agent 2', () => {
    const a2Idx = orchSrc.indexOf('[story-ac-remediator]');
    const a2Block = orchSrc.slice(a2Idx - 200, a2Idx + 800);
    expect(a2Block).toMatch(/PRD_FILE|prd.*file/i);
    expect(a2Block).toMatch(/_finding_json|finding.*json/i);
  });

  it('orch script reads acs_added from Agent 2 output to decide if remediation succeeded', () => {
    const a2Idx = orchSrc.indexOf('[story-ac-remediator]');
    // Widened window (2026-07-11): the deterministic AC-apply script (a full
    // Python heredoc that scans for and applies the agent's proposed ACs)
    // now sits between the agent call and the _remediation_applied check.
    const a2Block = orchSrc.slice(a2Idx, a2Idx + 5500);
    expect(a2Block).toMatch(/_acs_added/);
    expect(a2Block).toMatch(/_acs_added.*-gt 0|\[ "\${_acs_added:-0}" -gt 0/);
    expect(a2Block).toMatch(/_remediation_applied=1/);
  });
});
