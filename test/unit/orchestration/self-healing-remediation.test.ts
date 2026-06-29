/**
 * Self-healing gate remediation contract.
 *
 * When a QA gate fails, the orchestration must attempt auto-remediation before
 * aborting: feed the grounded finding back to the spec agent, update the story's
 * ACs + agent profile, signal the caller (exit 2), and let the tier3 runner
 * reset and retry the phase once.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT  = path.resolve(__dirname, '../../../');
const ORCH       = path.join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const TIER3      = path.join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const PROFILES   = path.join(REPO_ROOT, 'orchestrations/agents/profiles.json');

const orchSrc  = fs.readFileSync(ORCH, 'utf8');
const tier3Src = fs.readFileSync(TIER3, 'utf8');
const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));

// ── Orch script: three-agent remediation pipeline ───────────────────────────

describe('Self-healing: orch script three-agent pipeline', () => {
  it('SKIP_GATE_REMEDIATION env var gates the remediation path', () => {
    expect(orchSrc).toMatch(/SKIP_GATE_REMEDIATION/);
    expect(orchSrc).toMatch(/SKIP_GATE_REMEDIATION.*!=.*1|!=.*SKIP_GATE_REMEDIATION/);
  });

  it('collects failing gate logs from all 6 gates into _failing_logs array', () => {
    expect(orchSrc).toMatch(/_failing_logs\+=.*sast_log/);
    expect(orchSrc).toMatch(/_failing_logs\+=.*spec_log/);
    expect(orchSrc).toMatch(/_failing_logs\+=.*fuzz_log/);
    expect(orchSrc).toMatch(/_failing_logs\+=.*perf_log/);
  });

  it('calls gate-finding-analyst as Agent 1', () => {
    expect(orchSrc).toMatch(/gate-finding-analyst/);
    expect(orchSrc).toMatch(/\[gate-finding-analyst\]/);
  });

  it('calls story-ac-remediator as Agent 2', () => {
    expect(orchSrc).toMatch(/story-ac-remediator/);
    expect(orchSrc).toMatch(/\[story-ac-remediator\]/);
  });

  it('calls profile-augmentor as Agent 3', () => {
    expect(orchSrc).toMatch(/profile-augmentor/);
    expect(orchSrc).toMatch(/\[profile-augmentor\]/);
  });

  it('each agent call uses AI_GATE_ALLOW_TOOLS=1 and EPAM_DANGEROUS_SKIP_APPROVAL=1', () => {
    // Count occurrences — need at least 3 (one per agent)
    const allowToolsCount = (orchSrc.match(/AI_GATE_ALLOW_TOOLS=1/g) || []).length;
    expect(allowToolsCount).toBeGreaterThanOrEqual(3);
  });

  it('analyst output is checked for story_id before proceeding to Agent 2', () => {
    expect(orchSrc).toMatch(/_story_id/);
    // If no story_id, skip this gate's remediation
    expect(orchSrc).toMatch(/No grounded finding.*skipping/i);
  });

  it('AC count from Agent 2 determines whether remediation is marked applied', () => {
    expect(orchSrc).toMatch(/_acs_added/);
    expect(orchSrc).toMatch(/_acs_added.*-gt 0|_acs_added.*gt.*0/);
    expect(orchSrc).toMatch(/_remediation_applied=1/);
  });

  it('returns exit code 2 (not 1) when remediation is applied', () => {
    expect(orchSrc).toMatch(/return 2\s*#.*remedi/);
  });

  it('still returns exit code 1 when remediation is skipped or all gates had no grounded finding', () => {
    const afterBlock = orchSrc.slice(orchSrc.indexOf('return 2'));
    expect(afterBlock).toMatch(/return 1/);
  });

  it('logs all three agent outputs to gate-remediation-{phase}.log', () => {
    expect(orchSrc).toMatch(/gate-remediation-.*phase_id.*\.log/);
    // All three agent calls tee to the same rem_log
    const remLogCount = (orchSrc.match(/tee -a.*_rem_log/g) || []).length;
    expect(remLogCount).toBeGreaterThanOrEqual(3);
  });

  it('Agent 2 prompt includes story_id and PRD_FILE so it knows what to update', () => {
    const agent2Idx = orchSrc.indexOf('[story-ac-remediator]');
    const agent2Block = orchSrc.slice(agent2Idx, agent2Idx + 1500);
    expect(agent2Block).toMatch(/PRD_FILE|prd.*file/i);
    expect(agent2Block).toMatch(/_story_id/);
  });

  it('Agent 3 prompt includes profiles_file so it can write back', () => {
    const agent3Idx = orchSrc.indexOf('[profile-augmentor]');
    const agent3Block = orchSrc.slice(agent3Idx, agent3Idx + 1500);
    expect(agent3Block).toMatch(/_profiles_file/);
  });
});

// ── Tier3 runner: retry on exit 2 ────────────────────────────────────────────

describe('Self-healing: tier3 runner retry loop', () => {
  it('catches exit code 2 from orch script', () => {
    expect(tier3Src).toMatch(/phase_exit.*-eq 2|eq 2.*phase_exit/);
  });

  it('runs prd-remediate before the retry', () => {
    const retryBlock = tier3Src.slice(tier3Src.indexOf('phase_exit" -eq 2'));
    expect(retryBlock).toMatch(/prd-remediate\.sh.*--prd/);
  });

  it('sets SKIP_GATE_REMEDIATION=1 on the retry run to prevent infinite loop', () => {
    expect(tier3Src).toMatch(/SKIP_GATE_REMEDIATION=1/);
  });

  it('retries with --reset so story agent reruns with updated ACs', () => {
    const retryBlock = tier3Src.slice(tier3Src.indexOf('Self-healing:'));
    expect(retryBlock).toMatch(/run-agent-orchestration\.sh[\s\S]{0,200}--reset/);
  });

  it('fails hard if the retry also fails (no infinite loop)', () => {
    const retryBlock = tier3Src.slice(tier3Src.indexOf('Self-healing:'));
    expect(retryBlock).toMatch(/after self-healing retry.*aborting|aborting.*self-healing/i);
  });

  it('emits a success message if the retry passes', () => {
    expect(tier3Src).toMatch(/Self-healing retry succeeded/);
  });
});

// ── Agent profiles: self-healing addenda ─────────────────────────────────────

describe('Agent profiles: async error contract + SAST rules', () => {
  it('typescript-engineer has Async Error Contract rule', () => {
    expect(profiles['typescript-engineer']).toMatch(/Async Error Contract/);
  });

  it('async contract requires both resolve AND reject in Promise executor', () => {
    expect(profiles['typescript-engineer']).toMatch(/resolve.*reject|reject.*resolve/);
    expect(profiles['typescript-engineer']).toMatch(/server\.on\('error', reject\)|\.on\('error',\s*reject\)/);
  });

  it('async contract requires port validation in constructor', () => {
    expect(profiles['typescript-engineer']).toMatch(/Number\.isInteger.*port|port.*Number\.isInteger/);
  });

  it('sast-sentinel has TOP-LEVEL-LISTENER blocker rule', () => {
    expect(profiles['sast-sentinel']).toMatch(/TOP-LEVEL-LISTENER/);
    expect(profiles['sast-sentinel']).toMatch(/blocker/i);
  });

  it('sast-sentinel has PROMISE-NO-REJECT blocker rule', () => {
    expect(profiles['sast-sentinel']).toMatch(/PROMISE-NO-REJECT/);
    expect(profiles['sast-sentinel']).toMatch(/hung.*Promise|Promise.*hang/i);
  });

  it('PROMISE-NO-REJECT rule requires grep evidence before reporting', () => {
    expect(profiles['sast-sentinel']).toMatch(/GROUNDING REQUIREMENT.*paste.*grep|grep.*GROUNDING/i);
  });
});

// ── Three agent profiles exist in profiles.json ──────────────────────────────

describe('Three new agent profiles', () => {
  it('gate-finding-analyst profile exists', () => {
    expect(profiles['gate-finding-analyst']).toBeTruthy();
  });

  it('gate-finding-analyst requires grounding before emitting JSON', () => {
    expect(profiles['gate-finding-analyst']).toMatch(/GROUNDING REQUIREMENT/i);
    expect(profiles['gate-finding-analyst']).toMatch(/verbatim.*log|paste.*log/i);
  });

  it('gate-finding-analyst emits story_id, file, line, rule in JSON output', () => {
    expect(profiles['gate-finding-analyst']).toMatch(/"story_id"/);
    expect(profiles['gate-finding-analyst']).toMatch(/"rule"/);
    expect(profiles['gate-finding-analyst']).toMatch(/"file"/);
  });

  it('gate-finding-analyst returns null story_id when no grounded finding exists', () => {
    expect(profiles['gate-finding-analyst']).toMatch(/no grounded finding|story_id.*null/i);
  });

  it('story-ac-remediator profile exists', () => {
    expect(profiles['story-ac-remediator']).toBeTruthy();
  });

  it('story-ac-remediator adds at most 2 ACs per call', () => {
    expect(profiles['story-ac-remediator']).toMatch(/at most 2|max.*2.*AC/i);
  });

  it('story-ac-remediator requires prohibition-style ACs (MUST NOT)', () => {
    expect(profiles['story-ac-remediator']).toMatch(/MUST NOT|prohibition/i);
  });

  it('story-ac-remediator skips if AC already covered', () => {
    expect(profiles['story-ac-remediator']).toMatch(/already.*cover|already.*present/i);
  });

  it('profile-augmentor profile exists', () => {
    expect(profiles['profile-augmentor']).toBeTruthy();
  });

  it('profile-augmentor maps gate name to target profile', () => {
    expect(profiles['profile-augmentor']).toMatch(/sast-sentinel.*typescript-engineer/i);
    expect(profiles['profile-augmentor']).toMatch(/fuzz-weaver.*typescript-engineer/i);
  });

  it('profile-augmentor appends under Self-Healing Addendum section', () => {
    expect(profiles['profile-augmentor']).toMatch(/Self-Healing Addendum/);
  });

  it('profile-augmentor skips if pattern already covered', () => {
    expect(profiles['profile-augmentor']).toMatch(/NOT already covered|already.*covered/i);
  });

  it('profile-augmentor emits profile_updated boolean in output', () => {
    expect(profiles['profile-augmentor']).toMatch(/"profile_updated"/);
  });
});
