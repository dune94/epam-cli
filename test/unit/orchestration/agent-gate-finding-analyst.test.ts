/**
 * Contract tests for the gate-finding-analyst agent profile.
 *
 * This agent is Agent 1 in the self-healing pipeline. It reads a failed gate
 * log and the PRD, then emits a structured JSON finding. These tests verify
 * every invariant in the agent's contract without running the LLM.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PROFILES  = path.join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const ORCH      = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const agent: string = profiles['gate-finding-analyst'];
const orchSrc = fs.readFileSync(ORCH, 'utf8');

// ── Profile existence ────────────────────────────────────────────────────────

describe('gate-finding-analyst — profile existence', () => {
  it('profile key exists in profiles.json', () => {
    expect(profiles['gate-finding-analyst']).toBeTruthy();
    expect(typeof profiles['gate-finding-analyst']).toBe('string');
  });

  it('profile is non-trivially long (meaningful contract, not a stub)', () => {
    expect(agent.length).toBeGreaterThan(300);
  });
});

// ── Input contract ────────────────────────────────────────────────────────────

describe('gate-finding-analyst — input contract', () => {
  it('expects the gate log file path as input', () => {
    expect(agent).toMatch(/gate log file|log file path/i);
  });

  it('expects the gate name as input', () => {
    expect(agent).toMatch(/gate name|gate:/i);
  });

  it('expects the PRD file path as input', () => {
    expect(agent).toMatch(/PRD file/i);
  });
});

// ── Extraction process ────────────────────────────────────────────────────────

describe('gate-finding-analyst — extraction process', () => {
  it('instructs agent to read the gate log file (not guess its contents)', () => {
    expect(agent).toMatch(/Read the gate log|read.*log file/i);
  });

  it('targets the first BLOCKER finding (not just any finding)', () => {
    expect(agent).toMatch(/BLOCKER|blocker/);
  });

  it('extracts file, line, rule, message from the finding', () => {
    expect(agent).toMatch(/file.*absolute path|absolute path.*file/i);
    expect(agent).toMatch(/line.*integer|integer.*line/i);
    expect(agent).toMatch(/rule.*string|rule id/i);
    expect(agent).toMatch(/message.*string/i);
  });

  it('reads the PRD to map finding to owning story by technicalNotes.files', () => {
    expect(agent).toMatch(/technicalNotes\.files|technical.*notes.*files/i);
  });

  it('uses phase as tiebreaker when multiple stories own the same file', () => {
    expect(agent).toMatch(/multiple.*match|match.*multiple/i);
    expect(agent).toMatch(/phase/i);
  });

  it('falls back to the in_progress story when no file match is found', () => {
    expect(agent).toMatch(/in_progress|in progress/i);
  });
});

// ── Output contract — JSON schema ─────────────────────────────────────────────

describe('gate-finding-analyst — output schema', () => {
  it('output includes "gate" field', () => {
    expect(agent).toMatch(/"gate"/);
  });

  it('output includes "story_id" field', () => {
    expect(agent).toMatch(/"story_id"/);
  });

  it('output includes "file" field', () => {
    expect(agent).toMatch(/"file"/);
  });

  it('output includes "line" field (can be null)', () => {
    expect(agent).toMatch(/"line"/);
    expect(agent).toMatch(/null/);
  });

  it('output includes "rule" field', () => {
    expect(agent).toMatch(/"rule"/);
  });

  it('output includes "message" field', () => {
    expect(agent).toMatch(/"message"/);
  });

  it('output includes "suggested_fix" field (nullable)', () => {
    expect(agent).toMatch(/"suggested_fix"/);
  });
});

// ── Grounding requirement ─────────────────────────────────────────────────────

describe('gate-finding-analyst — grounding requirement', () => {
  it('requires verbatim log line proof before emitting JSON', () => {
    expect(agent).toMatch(/GROUNDING REQUIREMENT/i);
    expect(agent).toMatch(/verbatim.*log.*line|paste.*exact.*line/i);
  });

  it('emits story_id: null when no grounded evidence exists', () => {
    expect(agent).toMatch(/story_id.*null|null.*story_id/i);
  });

  it('includes "no grounded finding" as the error sentinel value', () => {
    expect(agent).toMatch(/no grounded finding/i);
  });

  it('explicitly prohibits hallucinating file paths or rule names', () => {
    expect(agent).toMatch(/Do NOT invent|Do NOT hallucinate/i);
  });
});

// ── Wiring in orch script ─────────────────────────────────────────────────────

describe('gate-finding-analyst — orch script wiring', () => {
  it('orch script labels Agent 1 log output with [gate-finding-analyst]', () => {
    expect(orchSrc).toMatch(/\[gate-finding-analyst\]/);
  });

  it('orch script reads the profile from profiles.json to build the prompt', () => {
    // The profile is loaded via _profiles_file variable set before the for-loop
    const analystIdx = orchSrc.indexOf('[gate-finding-analyst]');
    // Search a wider window: 1500 chars before the label (includes the for-loop preamble)
    const block = orchSrc.slice(analystIdx - 1500, analystIdx + 800);
    expect(block).toMatch(/_profiles_file|profiles_file/);
    expect(block).toMatch(/gate-finding-analyst/);
  });

  it('orch script checks _story_id from analyst output before running Agent 2', () => {
    expect(orchSrc).toMatch(/_story_id/);
    // Guard: if no story_id, skip to next gate
    expect(orchSrc).toMatch(/No grounded finding.*skipping|skipping.*no grounded/i);
  });

  it('orch script passes gate log path and PRD_FILE to the analyst prompt', () => {
    const analystIdx = orchSrc.indexOf('[gate-finding-analyst]');
    // The prompt is built after the label — search 1000 chars after
    const analystBlock = orchSrc.slice(analystIdx, analystIdx + 1000);
    expect(analystBlock).toMatch(/_glog|_glabel/);
    expect(analystBlock).toMatch(/PRD_FILE/);
  });
});
