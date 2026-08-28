/**
 * Story agents must emit story_start / story_complete / story_fail events to
 * agent-activity.jsonl so the dashboard shows real agent telemetry.
 *
 * Root cause (observed 2026-07-16): 51 entries in profiles.json = role definitions,
 * not live agents. agent-activity.jsonl only captured pre_phase_assessment events
 * from team-lead-agent (via update-monitor.sh). Story implementation agents
 * (typescript-engineer, test-engineer, etc.) never emitted events — they wrote to
 * their own per-story logs but were invisible to the dashboard. The "Active Agents"
 * count was permanently 1, regardless of how many stories ran.
 *
 * Fix: run-agent-orchestration.sh wraps run_story_with_watchdog with:
 *   update-monitor.sh story_start  <story> main <agentRole>   (before)
 *   update-monitor.sh story_complete <story> main              (on success)
 *   update-monitor.sh story_fail    <story> main <error>       (on failure)
 * The agentRole is extracted from the PRD (.agentRole field).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const orchSrc = readFileSync(
  join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'),
  'utf8',
);

// Isolate the section of the main story execution loop — from "Running: $story"
// through the checkpoint_complete call that follows the fail/complete branches.
function mainStoryLoopSection(): string {
  const startMarker = 'log "  Running: $story"';
  const endMarker = 'checkpoint_complete "$story"';
  const startIdx = orchSrc.indexOf(startMarker);
  expect(startIdx).toBeGreaterThan(-1);
  const endIdx = orchSrc.indexOf(endMarker, startIdx);
  expect(endIdx).toBeGreaterThan(startIdx);
  return orchSrc.slice(startIdx, endIdx + endMarker.length);
}

describe('story agent activity events — run-agent-orchestration.sh', () => {
  it('emits story_start before calling run_story_with_watchdog', () => {
    const section = mainStoryLoopSection();
    const startEmitIdx = section.indexOf('update-monitor.sh" story_start');
    const watchdogIdx  = section.indexOf('run_story_with_watchdog');
    expect(startEmitIdx).toBeGreaterThan(-1);
    expect(watchdogIdx).toBeGreaterThan(-1);
    expect(startEmitIdx).toBeLessThan(watchdogIdx);
  });

  it('story_start emit passes the story ID, lane (main), and agentRole from the PRD', () => {
    const section = mainStoryLoopSection();
    expect(section).toContain('update-monitor.sh" story_start "$story" "main" "$_story_monitor_role"');
    expect(section).toContain('.agentRole // "typescript-engineer"');
  });

  it('emits story_complete on success (after run_story_with_watchdog returns 0)', () => {
    const section = mainStoryLoopSection();
    expect(section).toContain('update-monitor.sh" story_complete "$story" "main"');
  });

  it('emits story_fail on failure (when _story_exit is non-zero)', () => {
    const section = mainStoryLoopSection();
    expect(section).toContain('update-monitor.sh" story_fail "$story" "main"');
  });

  it('story_complete appears only in the success branch (after story_tsc_gate)', () => {
    const section = mainStoryLoopSection();
    const tscGateIdx     = section.indexOf('story_tsc_gate');
    const completeEmitIdx = section.indexOf('update-monitor.sh" story_complete');
    expect(tscGateIdx).toBeGreaterThan(-1);
    // complete must appear after the tsc gate call, not in the failure branch
    expect(completeEmitIdx).toBeGreaterThan(tscGateIdx);
  });

  it('story_fail appears only in the failure branch (before story_tsc_gate)', () => {
    const section = mainStoryLoopSection();
    const tscGateIdx  = section.indexOf('story_tsc_gate');
    const failEmitIdx = section.indexOf('update-monitor.sh" story_fail');
    expect(tscGateIdx).toBeGreaterThan(-1);
    // fail must appear before the tsc gate call (it's in the else branch)
    expect(failEmitIdx).toBeGreaterThan(-1);
    expect(failEmitIdx).toBeLessThan(tscGateIdx);
  });
});

describe('agent-activity.html — Active Agents counter reads from event agent field', () => {
  const dashSrc = readFileSync(
    join(REPO_ROOT, 'orchestrations/dashboards/agent-activity.html'),
    'utf8',
  );

  it('stat-agents uses unique agent names from events (not a hardcoded count)', () => {
    expect(dashSrc).toContain("stat-agents').textContent = new Set(events.map(e => e.agent)).size");
  });

  it('dashboard fetches agent-activity.jsonl as its primary data source', () => {
    expect(dashSrc).toContain("fetchJsonl('logs/agent-activity.jsonl')");
  });
});
