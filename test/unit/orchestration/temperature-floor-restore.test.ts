/**
 * Root cause of a would-be regression (found while implementing, 2026-07-07):
 * a project-wide temperature pin (tier3-travel-app-run.sh's
 * EPAM_TEMPERATURE=0 for GLM models) is exported once at launcher level, but
 * implement_story() unconditionally ran `unset EPAM_TEMPERATURE` at the start
 * of every story (to stop a PRIOR story's mid-retry FailureDiversity override
 * from leaking into an unrelated story). Since every story is a fresh
 * claude.sh process that inherits the launcher's environment at start, that
 * unconditional unset would wipe the launcher's floor value before the very
 * first model call of every single story — silently defeating the pin.
 *
 * Fix: capture the launcher-provided value once at process start
 * (_claude_temperature_floor) and have the per-story reset RESTORE that floor
 * instead of unsetting to nothing — mid-story overrides still get cleared at
 * the next story boundary, but the launcher's own pin survives.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('claude.sh — temperature floor capture and restore (static)', () => {
  it('captures EPAM_TEMPERATURE once at process start, before any story processing', () => {
    const captureIdx = claudeSrc.indexOf('_claude_temperature_floor="${EPAM_TEMPERATURE:-}"');
    const storyLoopIdx = claudeSrc.indexOf('implement_story() {');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(storyLoopIdx);
  });

  it('restores the floor instead of unconditionally unsetting', () => {
    const idx = claudeSrc.indexOf('if [ -n "$_claude_temperature_floor" ]; then');
    expect(idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(idx, idx + 200);
    expect(block).toMatch(/export EPAM_TEMPERATURE="\$_claude_temperature_floor"/);
    expect(block).toMatch(/unset EPAM_TEMPERATURE/);
  });
});

describe('temperature floor restore — REAL execution', () => {
  function runStorySequence(opts: {
    launcherTemperature?: string;
    midStoryOverride?: string;
  }): { floorAfterFirstStory: string; floorAfterSecondStory: string } {
    const dir = mkdtempSync(join(tmpdir(), 'temp-floor-test-'));
    try {
      // Extract just the two relevant lines/blocks in isolation, exactly as
      // they appear in claude.sh, rather than the whole (huge) file.
      const captureLine = '_claude_temperature_floor="${EPAM_TEMPERATURE:-}"';
      const resetBlockStart = claudeSrc.indexOf('if [ -n "$_claude_temperature_floor" ]; then');
      const resetBlockEnd = claudeSrc.indexOf('\n    fi', resetBlockStart) + '\n    fi'.length;
      const resetBlock = claudeSrc.slice(resetBlockStart, resetBlockEnd);

      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          // Simulates claude.sh's process-start capture (runs once).
          captureLine,
          '',
          '# --- Simulated story 1 start ---',
          resetBlock,
          'echo "STORY1_TEMPERATURE=${EPAM_TEMPERATURE:-unset}"',
          opts.midStoryOverride ? `export EPAM_TEMPERATURE="${opts.midStoryOverride}"  # simulates FailureDiversity mid-retry pin` : '',
          '',
          '# --- Simulated story 2 start (fresh story boundary within same process) ---',
          resetBlock,
          'echo "STORY2_TEMPERATURE=${EPAM_TEMPERATURE:-unset}"',
        ]
          .filter((l) => l !== null)
          .join('\n'),
      );
      const env = { ...process.env };
      if (opts.launcherTemperature !== undefined) {
        env.EPAM_TEMPERATURE = opts.launcherTemperature;
      } else {
        delete env.EPAM_TEMPERATURE;
      }
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8', env });
      const floorAfterFirstStory = output.match(/STORY1_TEMPERATURE=(\S+)/)?.[1] ?? 'MISSING';
      const floorAfterSecondStory = output.match(/STORY2_TEMPERATURE=(\S+)/)?.[1] ?? 'MISSING';
      return { floorAfterFirstStory, floorAfterSecondStory };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a launcher-provided floor (e.g. "0") survives the per-story reset for every story', () => {
    const { floorAfterFirstStory, floorAfterSecondStory } = runStorySequence({ launcherTemperature: '0' });
    expect(floorAfterFirstStory).toBe('0');
    expect(floorAfterSecondStory).toBe('0');
  });

  it('a mid-story override (simulating FailureDiversity) does NOT leak into the next story — floor is restored', () => {
    const { floorAfterSecondStory } = runStorySequence({ launcherTemperature: '0', midStoryOverride: '0.9' });
    expect(floorAfterSecondStory).toBe('0');
  });

  it('when no launcher floor was set, behavior is unchanged: unset at every story boundary', () => {
    const { floorAfterFirstStory, floorAfterSecondStory } = runStorySequence({});
    expect(floorAfterFirstStory).toBe('unset');
    expect(floorAfterSecondStory).toBe('unset');
  });

  it('when no launcher floor was set, a mid-story override still does not leak (prior behavior preserved)', () => {
    const { floorAfterSecondStory } = runStorySequence({ midStoryOverride: '0.9' });
    expect(floorAfterSecondStory).toBe('unset');
  });
});
