/**
 * Contract tests for the profile-augmentor agent profile.
 *
 * Agent 3 in the self-healing pipeline. Receives the JSON finding and checks
 * whether the anti-pattern is already covered in the relevant agent profile.
 * If novel, appends a rule under "## Self-Healing Addendum". Tests verify the
 * gate-to-profile routing table, novelty check, append-only constraint, and
 * wiring in the orch script.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PROFILES  = path.join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const ORCH      = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const agent: string = profiles['profile-augmentor'];
const orchSrc = fs.readFileSync(ORCH, 'utf8');

// ── Profile existence ────────────────────────────────────────────────────────

describe('profile-augmentor — profile existence', () => {
  it('profile key exists in profiles.json', () => {
    expect(profiles['profile-augmentor']).toBeTruthy();
    expect(typeof profiles['profile-augmentor']).toBe('string');
  });

  it('profile is non-trivially long (meaningful contract, not a stub)', () => {
    expect(agent.length).toBeGreaterThan(300);
  });
});

// ── Input contract ────────────────────────────────────────────────────────────

describe('profile-augmentor — input contract', () => {
  it('expects a structured gate finding JSON', () => {
    expect(agent).toMatch(/gate finding|finding.*JSON/i);
  });

  it('expects the profiles.json file path', () => {
    expect(agent).toMatch(/profiles\.json/);
  });
});

// ── Gate-to-profile routing table ────────────────────────────────────────────

describe('profile-augmentor — gate-to-profile routing', () => {
  it('routes sast-sentinel findings to typescript-engineer profile', () => {
    expect(agent).toMatch(/sast-sentinel.*typescript-engineer/i);
  });

  it('routes spec-validator findings to openspec-agent profile', () => {
    expect(agent).toMatch(/spec-validator.*openspec-agent/i);
  });

  it('routes review-ranger findings to typescript-engineer profile', () => {
    expect(agent).toMatch(/review-ranger.*typescript-engineer/i);
  });

  it('routes mutant-hunter findings to test-engineer profile', () => {
    expect(agent).toMatch(/mutant-hunter.*test-engineer/i);
  });

  it('routes fuzz-weaver findings to typescript-engineer profile', () => {
    expect(agent).toMatch(/fuzz-weaver.*typescript-engineer/i);
  });

  it('routes perf-sentinel findings to typescript-engineer profile', () => {
    expect(agent).toMatch(/perf-sentinel.*typescript-engineer/i);
  });
});

// ── Novelty check (idempotency) ───────────────────────────────────────────────

describe('profile-augmentor — novelty check', () => {
  it('searches target profile for existing rule before appending', () => {
    expect(agent).toMatch(/Search.*target profile|check.*existing.*rule/i);
  });

  it('returns profile_updated: false when pattern is already covered', () => {
    expect(agent).toMatch(/NOT already covered|already.*covered.*stop/i);
    expect(agent).toMatch(/"profile_updated".*false|false.*"profile_updated"/i);
  });

  it('checks by rule id, not just by text similarity', () => {
    expect(agent).toMatch(/rule id|same.*rule id/i);
  });

  it('does not add the same rule twice', () => {
    expect(agent).toMatch(/NOT add.*twice|not.*same.*rule.*twice/i);
  });
});

// ── Rule quality constraints ──────────────────────────────────────────────────

describe('profile-augmentor — rule quality constraints', () => {
  it('rule is 2-4 sentences (concise, not encyclopedic)', () => {
    expect(agent).toMatch(/2.4 sentences|two.*four.*sentences/i);
  });

  it('rule names the anti-pattern and rule id explicitly', () => {
    expect(agent).toMatch(/anti.pattern.*rule id|rule id.*explicitly/i);
  });

  it('rule states MUST NOT and MUST alternative', () => {
    expect(agent).toMatch(/MUST NOT.*done instead|done instead|what MUST be done/i);
  });

  it('rule includes a one-line grep that detects the bad pattern', () => {
    expect(agent).toMatch(/one.line grep|grep.*fails.*bad pattern/i);
  });
});

// ── Append-only constraint ────────────────────────────────────────────────────

describe('profile-augmentor — append-only constraint', () => {
  it('only appends; never rewrites or reorganizes existing rules', () => {
    expect(agent).toMatch(/Only append|never rewrite|never.*reorganize/i);
  });

  it('appends under ## Self-Healing Addendum section', () => {
    expect(agent).toMatch(/Self-Healing Addendum/);
  });

  it('creates the Self-Healing Addendum section if it does not yet exist', () => {
    expect(agent).toMatch(/If the section.*already exists|append after the last rule/i);
  });

  it('writes profiles.json back atomically after appending', () => {
    expect(agent).toMatch(/Write.*profiles\.json.*back|atomically/i);
  });
});

// ── Output schema ─────────────────────────────────────────────────────────────

describe('profile-augmentor — output schema', () => {
  it('emits "profile" field naming which profile was updated', () => {
    expect(agent).toMatch(/"profile"/);
  });

  it('emits "profile_updated" boolean', () => {
    expect(agent).toMatch(/"profile_updated"/);
  });

  it('emits "rule_id" of the appended rule', () => {
    expect(agent).toMatch(/"rule_id"/);
  });

  it('emits "rule_text" with the full rule content', () => {
    expect(agent).toMatch(/"rule_text"/);
  });
});

// ── Wiring in orch script ─────────────────────────────────────────────────────

describe('profile-augmentor — orch script wiring', () => {
  it('orch script labels Agent 3 log output with [profile-augmentor]', () => {
    expect(orchSrc).toMatch(/\[profile-augmentor\]/);
  });

  it('orch script calls Agent 3 after Agent 2, unconditionally (even if 0 ACs added)', () => {
    const remediator = orchSrc.indexOf('[story-ac-remediator]');
    const augmentor  = orchSrc.indexOf('[profile-augmentor]');
    // profile-augmentor must appear AFTER story-ac-remediator
    expect(augmentor).toBeGreaterThan(remediator);
  });

  it('orch script passes _profiles_file and finding JSON to Agent 3', () => {
    const a3Idx = orchSrc.indexOf('[profile-augmentor]');
    const a3Block = orchSrc.slice(a3Idx - 200, a3Idx + 800);
    expect(a3Block).toMatch(/_profiles_file/);
    expect(a3Block).toMatch(/_finding_json|finding.*json/i);
  });

  it('orch script checks profile_updated: true to log success', () => {
    // profile_updated grep and success message appear after the reviewer block
    expect(orchSrc).toMatch(/profile_updated.*true|profile_updated"[^"]*:[^"]*true/);
    expect(orchSrc).toMatch(/\[profile-augmentor\].*Profile updated/is);
  });

  it('Agent 3 result does NOT affect _remediation_applied (profile update is a bonus)', () => {
    // _remediation_applied is only set by Agent 2 (_acs_added > 0)
    // Agent 3 success/failure must not set or clear it
    const a3Idx = orchSrc.indexOf('[profile-augmentor]');
    const a3Block = orchSrc.slice(a3Idx, a3Idx + 1500);
    expect(a3Block).not.toMatch(/_remediation_applied=1/);
  });
});
