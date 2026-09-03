// update-monitor.sh's story_start USED TO DEFAULT PROVIDER TO "claude" WHEN NO 5TH ARG WAS GIVEN.
//
// TIER 3 in change-log/SEAM-CONSISTENCY-ANALYSIS.md: this is DISPLAY ONLY — the value is written
// into agent-status.json for the dashboard, never used to route an actual call — but a caller
// that passed no provider still had the dashboard confidently report "claude", wrong whenever the
// real run used anything else.
//
// This test EXECUTES the real script and asserts on the JSON artifact it writes, not the source.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/update-monitor.sh');

function storyStart(args: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'monitor-'));
  mkdirSync(join(d, 'logs'), { recursive: true });
  const monitorFile = join(d, 'logs/agent-status.json');
  const activityFile = join(d, 'logs/agent-activity.jsonl');
  spawnSync('bash', [SCRIPT, 'init', 'phase1'], {
    encoding: 'utf8', env: { ...process.env, MONITOR_FILE: monitorFile, ACTIVITY_FILE: activityFile },
  });
  spawnSync('bash', [SCRIPT, 'story_start', ...args], {
    encoding: 'utf8', env: { ...process.env, MONITOR_FILE: monitorFile, ACTIVITY_FILE: activityFile },
  });
  const data = JSON.parse(readFileSync(monitorFile, 'utf8'));
  rmSync(d, { recursive: true, force: true });
  return data;
}

describe('update-monitor.sh story_start — the PROVIDER field', () => {
  it('is EMPTY when no provider argument is given — not "claude"', () => {
    const data = storyStart(['S-1', 'main', 'writer', 'A story']);
    const story = data.stories?.['S-1'] ?? Object.values(data.stories ?? {})[0];
    expect(story?.provider ?? '', JSON.stringify(data)).toBe('');
  });

  it('carries the real value when one is given', () => {
    const data = storyStart(['S-1', 'main', 'writer', 'A story', 'openrouter']);
    const story = data.stories?.['S-1'] ?? Object.values(data.stories ?? {})[0];
    expect(story?.provider, JSON.stringify(data)).toBe('openrouter');
  });
});
