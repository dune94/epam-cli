/**
 * Observability gaps — tests for all 4 gaps identified after the 2026-07-17 run:
 *
 * Gap 1 — openspec HIGH ladder: SPEC_AGENT_MAX_RETRIES defaults to 3 for openspec;
 *          retry 2+ escalates to SPEC_MODE_OPENSPEC_MODEL_HIGH and emits
 *          spec_timeout_escalation event.
 *
 * Gap 2 — ladder-up visibility: update-monitor.sh emits ladder_rung to
 *          agent-activity.jsonl with prevModel in detail; claude.sh captures
 *          _prev_model before the case block and passes it as 8th arg.
 *
 * Gap 3 — failure-analyst cycle visibility: self_heal_start emitted when analyst
 *          begins; self_heal_result emitted after diagnosis + patch applied.
 *
 * Gap 4 — SPEC_PASS_BLOCK_ON_TIMEOUT=true in tier3-skyscanner-app-run.sh; the
 *          blocking gate already exists in run-agent-orchestration.sh.
 */

import { describe, it, expect } from 'vitest';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../..');
const SPEC_MODE_SRC   = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const UPDATE_MON_SRC  = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/update-monitor.sh'), 'utf8');
const CLAUDE_SH_SRC   = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const TIER3_SKY_SRC   = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/tier3-skyscanner-app-run.sh'), 'utf8');

// ── Gap 1: openspec HIGH ladder ───────────────────────────────────────────────

describe('Gap 1 — openspec HIGH ladder', () => {
  it('defaults SPEC_AGENT_MAX_RETRIES to 3 for all spec agents (4 total attempts)', () => {
    // Both openspec and speckit get 3 retries — neither may fail silently.
    expect(SPEC_MODE_SRC).toContain("SPEC_AGENT_MAX_RETRIES || '3'");
  });

  it('detects openspec via _isOpenspec flag', () => {
    expect(SPEC_MODE_SRC).toContain("const _isOpenspec = agent === 'openspec'");
  });

  it('reads SPEC_MODE_OPENSPEC_MODEL_HIGH env var for escalation model', () => {
    expect(SPEC_MODE_SRC).toContain('SPEC_MODE_OPENSPEC_MODEL_HIGH');
  });

  it('escalates to HIGH model only on retry 2+ (not retry 1)', () => {
    // Retry 1 is a same-model transient retry. Only retry 2+ escalates.
    expect(SPEC_MODE_SRC).toContain('_specRetry >= 2');
  });

  it('emits spec_timeout_escalation appendSpecPassEvent on model switch', () => {
    expect(SPEC_MODE_SRC).toContain("event: 'spec_timeout_escalation'");
  });

  it('includes prevModel and newModel in escalation event detail (generic — covers both openspec and speckit)', () => {
    // Generic _prevModel/_nextModel used so both openspec and speckit escalation
    // events share the same appendSpecPassEvent call shape.
    expect(SPEC_MODE_SRC).toContain('prevModel: _prevModel');
    expect(SPEC_MODE_SRC).toContain('newModel: _nextModel');
  });

  it('restores SPEC_MODE_OPENSPEC_MODEL after escalation attempt (env safety)', () => {
    // The escalation temporarily overrides the env var then restores it in a
    // finally block — prevents env pollution across stories.
    expect(SPEC_MODE_SRC).toContain('process.env.SPEC_MODE_OPENSPEC_MODEL = _savedModel');
  });

  it('tier3-skyscanner exports SPEC_MODE_OPENSPEC_MODEL_HIGH', () => {
    expect(TIER3_SKY_SRC).toContain('SPEC_MODE_OPENSPEC_MODEL_HIGH');
  });
});

// ── Gap 2: ladder-up visibility in agent-activity ─────────────────────────────

describe('Gap 2 — ladder-up events in agent-activity', () => {
  it('normalize_activity_type accepts ladder_rung', () => {
    // ladder_rung must not map to "info" — it must pass through as-is
    expect(UPDATE_MON_SRC).toMatch(/ladder_rung.*retry|retry.*ladder_rung/);
  });

  it('normalize_activity_type accepts retry', () => {
    expect(UPDATE_MON_SRC).toContain('retry');
  });

  it('normalize_activity_type accepts self_heal_start', () => {
    expect(UPDATE_MON_SRC).toContain('self_heal_start');
  });

  it('normalize_activity_type accepts self_heal_result', () => {
    expect(UPDATE_MON_SRC).toContain('self_heal_result');
  });

  it('append_activity_event accepts prev_model as 9th arg', () => {
    // The function must accept $9 as prev_model
    const funcStart = UPDATE_MON_SRC.indexOf('append_activity_event()');
    const funcEnd   = UPDATE_MON_SRC.indexOf('\n}', funcStart);
    const body      = UPDATE_MON_SRC.slice(funcStart, funcEnd);
    expect(body).toContain('prev_model=');
  });

  it('append_activity_event writes prevModel into detail', () => {
    expect(UPDATE_MON_SRC).toContain('prevModel');
  });

  it('event handler passes 8th arg to append_activity_event as prev_model', () => {
    const evtStart = UPDATE_MON_SRC.indexOf('event)');
    const evtEnd   = UPDATE_MON_SRC.indexOf(';;', evtStart);
    const body     = UPDATE_MON_SRC.slice(evtStart, evtEnd);
    expect(body).toContain('EVENT_PREV_MODEL');
  });

  it('claude.sh captures _prev_model BEFORE the ladder case statement', () => {
    // Must be captured before STORY_MODEL is changed by the ladder step
    const ladderStart = CLAUDE_SH_SRC.indexOf('InferenceLadder\n');
    const linesBefore = CLAUDE_SH_SRC.slice(0, CLAUDE_SH_SRC.indexOf('case "$_rung"'));
    // _prev_model capture must appear before the case block
    const prevModelIdx = linesBefore.lastIndexOf('_prev_model=');
    expect(prevModelIdx).toBeGreaterThan(0);
  });

  it('claude.sh passes _prev_model as 8th arg to update-monitor.sh ladder_rung event', () => {
    // The ladder_rung event call must end with "${_prev_model:-}"
    expect(CLAUDE_SH_SRC).toContain('"${_prev_model:-}"');
  });

  it('ladder_rung message shows prevModel→newModel transition', () => {
    expect(CLAUDE_SH_SRC).toContain('${_prev_model:-default}→${STORY_MODEL:-default}');
  });

  it('update-monitor.sh — ladder_rung writes prevModel to agent-activity.jsonl (runtime)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-rung-test-'));
    try {
      mkdirSync(join(dir, 'logs'));
      const monitorFile = join(dir, 'logs', 'agent-status.json');
      writeFileSync(monitorFile, '{"phase":"core","events":[],"stories":{},"lanes":{}}');

      execSync(
        `MONITOR_FILE="${monitorFile}" ACTIVITY_FILE="${dir}/logs/agent-activity.jsonl" \
         bash orchestrations/scripts/update-monitor.sh \
         event ladder_rung "kimi-k2→glm-5.1 effort=medium" "SKY-TEST" "main" "typescript-engineer" "z-ai/glm-5.1" "zhipuai" "moonshotai/kimi-k2"`,
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );

      const lines = readFileSync(join(dir, 'logs', 'agent-activity.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.type).toBe('ladder_rung');
      expect(record.model).toBe('z-ai/glm-5.1');
      expect(record.detail.prevModel).toBe('moonshotai/kimi-k2');
      expect(record.story_id).toBe('SKY-TEST');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Gap 3: failure-analyst cycle in agent-activity ────────────────────────────

describe('Gap 3 — failure-analyst cycle visibility', () => {
  it('claude.sh emits self_heal_start when failure analyst begins', () => {
    // self_heal_start must appear BEFORE the LLM call in run_failure_analyst
    const funcStart = CLAUDE_SH_SRC.indexOf('run_failure_analyst()');
    // ai-run.sh is called with `bash "$SCRIPT_DIR/ai-run.sh" --provider ...`
    const llmCallIdx = CLAUDE_SH_SRC.indexOf('ai-run.sh" --provider', funcStart);
    const healStartIdx = CLAUDE_SH_SRC.indexOf('self_heal_start', funcStart);
    expect(healStartIdx).toBeGreaterThan(0);
    expect(llmCallIdx).toBeGreaterThan(0);
    expect(healStartIdx).toBeLessThan(llmCallIdx);
  });

  it('claude.sh emits self_heal_result after run_healing_recorder', () => {
    // self_heal_result must appear AFTER run_healing_recorder call
    const funcStart = CLAUDE_SH_SRC.indexOf('run_failure_analyst()');
    const recorderIdx = CLAUDE_SH_SRC.indexOf('run_healing_recorder "$story_id"', funcStart);
    const healResultIdx = CLAUDE_SH_SRC.indexOf('self_heal_result', recorderIdx);
    expect(healResultIdx).toBeGreaterThan(recorderIdx);
  });

  it('self_heal_result message includes target, patches, and profile_updated', () => {
    const idx = CLAUDE_SH_SRC.indexOf('self_heal_result');
    const msg = CLAUDE_SH_SRC.slice(idx, idx + 300);
    expect(msg).toContain('target=');
    expect(msg).toContain('patches=');
    expect(msg).toContain('profile=');
  });

  it('update-monitor.sh — self_heal_start writes to agent-activity.jsonl (runtime)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-heal-start-test-'));
    try {
      mkdirSync(join(dir, 'logs'));
      const monitorFile = join(dir, 'logs', 'agent-status.json');
      writeFileSync(monitorFile, '{"phase":"core","events":[],"stories":{},"lanes":{}}');

      execSync(
        `MONITOR_FILE="${monitorFile}" ACTIVITY_FILE="${dir}/logs/agent-activity.jsonl" \
         bash orchestrations/scripts/update-monitor.sh \
         event self_heal_start "Self-heal started for SKY-002 (attempt 1, gate=glm-5.1)" \
         "SKY-002" "main" "failure-analyst" "z-ai/glm-5.1" "zhipuai"`,
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );

      const lines = readFileSync(join(dir, 'logs', 'agent-activity.jsonl'), 'utf8').trim().split('\n');
      const record = JSON.parse(lines[0]);
      expect(record.type).toBe('self_heal_start');
      expect(record.agent).toBe('failure-analyst');
      expect(record.story_id).toBe('SKY-002');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('update-monitor.sh — self_heal_result writes to agent-activity.jsonl (runtime)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-heal-result-test-'));
    try {
      mkdirSync(join(dir, 'logs'));
      const monitorFile = join(dir, 'logs', 'agent-status.json');
      writeFileSync(monitorFile, '{"phase":"core","events":[],"stories":{},"lanes":{}}');

      execSync(
        `MONITOR_FILE="${monitorFile}" ACTIVITY_FILE="${dir}/logs/agent-activity.jsonl" \
         bash orchestrations/scripts/update-monitor.sh \
         event self_heal_result "Self-heal result for SKY-002: target=skill patches=0 profile=true — wrong import casing" \
         "SKY-002" "main" "failure-analyst" "z-ai/glm-5.1" "zhipuai"`,
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );

      const lines = readFileSync(join(dir, 'logs', 'agent-activity.jsonl'), 'utf8').trim().split('\n');
      const record = JSON.parse(lines[0]);
      expect(record.type).toBe('self_heal_result');
      expect(record.detail.message).toContain('target=skill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Gap 4: SPEC_PASS_BLOCK_ON_TIMEOUT ────────────────────────────────────────

describe('Gap 4 — SPEC_PASS_BLOCK_ON_TIMEOUT', () => {
  it('tier3-skyscanner sets SPEC_PASS_BLOCK_ON_TIMEOUT=true by default', () => {
    expect(TIER3_SKY_SRC).toContain('SPEC_PASS_BLOCK_ON_TIMEOUT="${SPEC_PASS_BLOCK_ON_TIMEOUT:-true}"');
  });

  it('run-agent-orchestration.sh reads specPassFailed flag when SPEC_PASS_BLOCK_ON_TIMEOUT=true', () => {
    const orchSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(orchSrc).toContain('SPEC_PASS_BLOCK_ON_TIMEOUT');
    expect(orchSrc).toContain('specPassFailed');
  });

  it('spec-mode-runner.js aborts pipeline (process.exit(1)) when an agent returns null after all retries', () => {
    // New policy: openspec/speckit failures are not permitted — hard exit instead of
    // setting specPassFailed and continuing. The orch.sh block gate for specPassFailed
    // is kept as a backstop but spec-mode-runner no longer relies on it.
    expect(SPEC_MODE_SRC).toContain('openspec/speckit failures are not permitted');
    expect(SPEC_MODE_SRC).toContain('process.exit(1)');
  });
});
