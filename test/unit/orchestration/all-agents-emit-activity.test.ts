/**
 * Every agent must emit to agent-activity.html — no omissions (user, 2026-07-24).
 * Found live: the code-graph-detective, the test-writer, and the failure-agent emitted
 * NOTHING (0 occurrences in agent-activity.jsonl) while every other agent did — so three
 * important agents were invisible in the dashboard. Each must emit start + complete/fail
 * with its own role, like the impl/spec/review agents.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '../../../orchestrations/scripts', p), 'utf8');
const detective = read('spec-mode-runner.js');
const testWriter = read('brownfield-repro-test-writer.sh');
const analyst = read('agent-attempt-analyst.sh');

describe('code-graph-detective emits activity (start + complete + fail)', () => {
  it('emits under role code-graph-detective', () => {
    expect(detective).toMatch(/role: 'code-graph-detective'/);
  });
  it('emits a START and both outcomes (located fix site / found NO fix site)', () => {
    expect(detective).toMatch(/code-graph-detective started on/);
    expect(detective).toMatch(/code-graph-detective located fix site/);
    expect(detective).toMatch(/code-graph-detective (located NO|found NO) fix site/);
  });
});

describe('repro-test-writer emits activity (start + complete + fail)', () => {
  it('emits via update-monitor under role repro-test-writer', () => {
    expect(testWriter).toMatch(/update-monitor\.sh" event .*"repro-test-writer"/);
  });
  it('emits started, committed, and NO-test outcomes', () => {
    expect(testWriter).toMatch(/repro-test-writer started for/);
    expect(testWriter).toMatch(/repro-test-writer committed reproducing test/);
    expect(testWriter).toMatch(/repro-test-writer produced NO test/);
  });
});

describe('failure-agent (agent-attempt-analyst) emits activity (start + complete)', () => {
  it('emits via update-monitor under role failure-analyst', () => {
    expect(analyst).toMatch(/update-monitor\.sh" event .*"failure-analyst"/);
  });
  it('emits self_heal start and complete', () => {
    expect(analyst).toMatch(/self_heal_start.*failure-analyst diagnosing/);
    expect(analyst).toMatch(/self_heal_complete.*failure-analyst prescribed/);
  });
});
