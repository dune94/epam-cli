/**
 * Spec-pass decisions surface in agent-activity dashboard.
 *
 * Root event (2026-07-15): "prd-change-reviewer REJECTED speckit's changes to
 * SKY-002 after 3 attempt(s)" was buried in the tier3 log with no dashboard
 * representation. This instruments all 9 decision points in spec-mode-runner.js
 * so they write `spec_pass_decision` events directly to agent-activity.jsonl.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_MODE_SRC  = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const LOGGER_SRC     = readFileSync(join(REPO_ROOT, 'src/logging/AgentActivityLogger.ts'), 'utf8');
const DASHBOARD_SRC  = readFileSync(join(REPO_ROOT, 'orchestrations/dashboards/agent-activity.html'), 'utf8');

describe('appendSpecPassEvent — helper definition', () => {
  it('appendSpecPassEvent function is defined in spec-mode-runner.js', () => {
    expect(SPEC_MODE_SRC).toContain('function appendSpecPassEvent(');
  });

  it('appendSpecPassEvent writes to agent-activity.jsonl (not a different log)', () => {
    expect(SPEC_MODE_SRC).toContain("'agent-activity.jsonl'");
  });

  it('appendSpecPassEvent emits the correct JSONL shape (type field = spec_pass_decision)', () => {
    expect(SPEC_MODE_SRC).toContain("type: 'spec_pass_decision'");
  });

  it('appendSpecPassEvent includes event_id and timestamp fields', () => {
    expect(SPEC_MODE_SRC).toContain('event_id:');
    expect(SPEC_MODE_SRC).toContain('timestamp:');
  });

  it('appendSpecPassEvent sets agent to spec-coordinator-agent', () => {
    expect(SPEC_MODE_SRC).toContain("agent: 'spec-coordinator-agent'");
  });
});

describe('appendSpecPassEvent — call sites (spec-mode-runner.js)', () => {
  it('reviewer REJECTED path calls appendSpecPassEvent with event=reviewer_rejected', () => {
    expect(SPEC_MODE_SRC).toContain("event: 'reviewer_rejected'");
  });

  it('reviewer ACCEPTED path calls appendSpecPassEvent with event=reviewer_accepted', () => {
    expect(SPEC_MODE_SRC).toContain("event: 'reviewer_accepted'");
  });

  it('spec-pass coherence violation calls appendSpecPassEvent with event=coherence_violation', () => {
    expect(SPEC_MODE_SRC).toContain("event: 'coherence_violation'");
  });

  it('mid-execution coherence violation calls appendSpecPassEvent (source: mid_execution)', () => {
    expect(SPEC_MODE_SRC).toContain("source: 'mid_execution'");
  });

  it('mandate violation detection calls appendSpecPassEvent with decision=pending_retry', () => {
    expect(SPEC_MODE_SRC).toContain("decision: 'pending_retry'");
  });

  it('mandate violation RESOLVED calls appendSpecPassEvent with decision=resolved', () => {
    expect(SPEC_MODE_SRC).toContain("decision: 'resolved'");
  });

  it('mandate violation UNRESOLVED calls appendSpecPassEvent with decision=unresolved', () => {
    expect(SPEC_MODE_SRC).toContain("decision: 'unresolved'");
  });

  it('story_delegated event is emitted when parent ACs are redistributed to children', () => {
    expect(SPEC_MODE_SRC).toContain("event: 'story_delegated'");
  });

  it('story_restored event is emitted when parent is resurrected after all children deprecated', () => {
    expect(SPEC_MODE_SRC).toContain("event: 'story_restored'");
  });
});

describe('ActivityEventType — TypeScript union', () => {
  it("spec_pass_decision is in ActivityEventType union in AgentActivityLogger.ts", () => {
    expect(LOGGER_SRC).toContain("'spec_pass_decision'");
  });
});

describe('agent-activity.html — spec_pass_decision rendering', () => {
  it('renders spec_pass_decision event type in the timeline', () => {
    expect(DASHBOARD_SRC).toContain('spec_pass_decision');
  });

  it('applies decision-* CSS class for colour coding (rejected=red, accepted=green, etc.)', () => {
    expect(DASHBOARD_SRC).toContain('decision-rejected');
    expect(DASHBOARD_SRC).toContain('decision-accepted');
    expect(DASHBOARD_SRC).toContain('decision-resolved');
    expect(DASHBOARD_SRC).toContain('decision-unresolved');
  });

  it('formatDetail handles spec_pass_decision event type with human-readable labels', () => {
    expect(DASHBOARD_SRC).toContain('reviewer_rejected');
    expect(DASHBOARD_SRC).toContain('reviewer_accepted');
    expect(DASHBOARD_SRC).toContain('story_delegated');
    expect(DASHBOARD_SRC).toContain('story_restored');
  });

  it('filter options include a Spec Pass Decision label for the type dropdown', () => {
    expect(DASHBOARD_SRC).toContain('Spec Pass Decision');
  });
});

describe('appendSpecPassEvent — REAL execution, JSONL shape', () => {
  it('writes a valid JSONL line with the correct spec_pass_decision shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-pass-event-'));
    try {
      mkdirSync(join(dir, 'logs'), { recursive: true });

      // Extract appendJsonl + appendSpecPassEvent from the source and run them in isolation
      const appendJsonlMatch = SPEC_MODE_SRC.match(/^function appendJsonl\([\s\S]+?\n\}/m);
      const appendSpecPassMatch = SPEC_MODE_SRC.match(/^function appendSpecPassEvent\([\s\S]+?\n\}/m);
      expect(appendJsonlMatch, 'appendJsonl not found in source').toBeTruthy();
      expect(appendSpecPassMatch, 'appendSpecPassEvent not found in source').toBeTruthy();

      const scriptPath = join(dir, 'run.sh.js');
      writeFileSync(scriptPath, [
        `const path = require('path');`,
        `const fs = require('fs');`,
        appendJsonlMatch![0],
        appendSpecPassMatch![0],
        `appendSpecPassEvent(${JSON.stringify(join(dir, 'logs'))}, {`,
        `  storyId: 'SKY-TEST',`,
        `  phase: 'core',`,
        `  event: 'mandate_violation',`,
        `  decision: 'pending_retry',`,
        `  details: { reason: '15 acceptance criteria (> 12)' }`,
        `});`,
      ].join('\n'));

      execFileSync('node', [scriptPath], { encoding: 'utf8' });

      const outPath = join(dir, 'logs', 'agent-activity.jsonl');
      const lines = readFileSync(outPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]);
      expect(record.type).toBe('spec_pass_decision');
      expect(record.agent).toBe('spec-coordinator-agent');
      expect(record.story_id).toBe('SKY-TEST');
      expect(record.phase).toBe('core');
      expect(record.detail.event).toBe('mandate_violation');
      expect(record.detail.decision).toBe('pending_retry');
      expect(record.detail.reason).toBeTruthy();
      expect(typeof record.event_id).toBe('string');
      expect(record.event_id.startsWith('evt-')).toBe(true);
      expect(typeof record.timestamp).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spec-mode-runner.js — all agent calls guarded against thrown exceptions', () => {
  it('initial runSpeckitReview/runSpecAgent call (per-story loop) is wrapped in try/catch so thrown errors enter the retry loop', () => {
    const agentResultIdx = SPEC_MODE_SRC.indexOf('let agentResult;');
    expect(agentResultIdx).toBeGreaterThan(-1);
    const loopBody = SPEC_MODE_SRC.slice(agentResultIdx, agentResultIdx + 2000);

    const tryCatchIdx = loopBody.indexOf('try {');
    const speckitCallIdx = loopBody.indexOf('runSpeckitReview({');
    expect(tryCatchIdx).toBeGreaterThan(-1);
    expect(speckitCallIdx).toBeGreaterThan(tryCatchIdx);
    expect(loopBody).toContain('} catch (err) { agentResult = null; }');
    const whileLoopIdx = loopBody.indexOf('while (!agentResult');
    expect(whileLoopIdx).toBeGreaterThan(tryCatchIdx);
  });

  it('model-review runAgentForJson call is wrapped in try/catch (non-critical, null = skip model reassignment)', () => {
    const modelReviewIdx = SPEC_MODE_SRC.indexOf('spec-model-review-');
    expect(modelReviewIdx).toBeGreaterThan(-1);
    const block = SPEC_MODE_SRC.slice(Math.max(0, modelReviewIdx - 400), modelReviewIdx + 200);
    expect(block).toContain('try {');
    expect(block).toContain('} catch (err) { llmDecisions = null; }');
  });

  it('mid-execution split runSpeckitReview call is wrapped in try/catch (non-critical, null = skip refinements)', () => {
    const midSplitIdx = SPEC_MODE_SRC.indexOf('Mid-execution split registered by agent');
    expect(midSplitIdx).toBeGreaterThan(-1);
    const block = SPEC_MODE_SRC.slice(midSplitIdx, midSplitIdx + 700);
    expect(block).toContain('try {');
    expect(block).toContain('} catch (err) { speckitResult = null; }');
  });
});
