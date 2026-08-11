/**
 * A TIMEOUT THAT CANNOT ACCOMMODATE THE ITERATION BUDGET IS A SCHEDULED KILL THAT STILL BILLS.
 *
 * The two numbers were set independently. Measured on run 20260810T024709Z:
 *
 *   kimi-k3   maxIterations 150 + rung-3 bump 30 = 180 iterations
 *   watchdog  storyTimeoutSecs 1800 (flat)
 *             -> 10 seconds per turn, INCLUDING tool execution
 *
 * 10 of 23 writer invocations were SIGKILLed mid-flight having produced nothing — and they were
 * the most expensive attempts of the run (25.4 min, ~2.2M input tokens each). The policy then
 * retried with a LONGER budget on a costlier model, so failing to finish bought more time rather
 * than less scope.
 *
 * The wall is now DERIVED from the budget it polices: secondsPerIteration x maxIterations,
 * never below the configured floor, capped by storyTimeoutMaxSecs. Both knobs are config
 * (timeouts.*) — no seconds appear in the engine.
 *
 * Loaded in the PARENT process (lib/story-guards.sh::_load_timeout_config), because the watchdog
 * runs there. claude.sh's own loader is a subprocess and too late by construction — the reason
 * _load_timeout_config exists at all, and a trap this change nearly fell into.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const ORCH = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
const GUARDS = readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-guards.sh'), 'utf8');
const CFG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));

const SPI: number = CFG.timeouts.secondsPerIteration;
const CAP: number = CFG.timeouts.storyTimeoutMaxSecs;
const FLOOR: number = CFG.timeouts.storyTimeoutSecs;

/** Executes the real derivation block from run-agent-orchestration.sh. */
function derive(iterations: number, floor = FLOOR): number {
  const i = ORCH.indexOf('    # THE WALL MUST HONOUR THE ITERATION BUDGET');
  expect(i, 'the derivation block moved — re-anchor this test').toBeGreaterThan(-1);
  const block = ORCH.slice(i, ORCH.indexOf('    set +e', i)).replace(/\blocal /g, '');
  const out = execFileSync('bash', ['-c',
    `set -u
     log() { :; }
     timeout_secs=${floor}
     EPAM_SECONDS_PER_ITERATION=${SPI}
     EPAM_STORY_TIMEOUT_MAX_SECS=${CAP}
     EPAM_MAX_ITERATIONS=${iterations}
${block}
     printf '%s' "$timeout_secs"`], { encoding: 'utf8' });
  return Number(out.trim());
}

describe('the wall accommodates the work it is policing', () => {
  it('THE DEFECT: the 180-iteration budget no longer gets a 1800s wall', () => {
    const derived = derive(180);
    expect(
      derived,
      'kimi-k3 at rung 3 had 10s per turn including tool execution — a guaranteed kill',
    ).toBe(180 * SPI);
    expect(derived).toBeGreaterThan(FLOOR);
  });

  it('scales with the budget', () => {
    expect(derive(200)).toBe(200 * SPI);
  });
});

describe('the floor and the cap both hold', () => {
  it('never drops BELOW the configured floor, however small the budget', () => {
    // Deriving downward would shorten walls for cheap attempts that are working fine.
    expect(derive(20)).toBe(FLOOR);
    expect(derive(1)).toBe(FLOOR);
  });

  it('never exceeds the configured cap, however large the budget', () => {
    expect(derive(5000)).toBe(CAP);
  });

  it('a budget exactly at the floor leaves the wall unchanged', () => {
    expect(derive(Math.floor(FLOOR / SPI))).toBe(FLOOR);
  });
});

describe('it degrades safely when the knobs are absent', () => {
  it('no secondsPerIteration means the flat timeout is used, unchanged', () => {
    const i = ORCH.indexOf('    # THE WALL MUST HONOUR THE ITERATION BUDGET');
    const block = ORCH.slice(i, ORCH.indexOf('    set +e', i)).replace(/\blocal /g, '');
    const out = execFileSync('bash', ['-c',
      `set -u\nlog() { :; }\ntimeout_secs=1800\nEPAM_MAX_ITERATIONS=180\n${block}\nprintf '%s' "$timeout_secs"`],
      { encoding: 'utf8' });
    expect(Number(out.trim()), 'an unconfigured project had its timeout silently changed').toBe(1800);
  });

  it('no iteration budget means the flat timeout is used, unchanged', () => {
    const i = ORCH.indexOf('    # THE WALL MUST HONOUR THE ITERATION BUDGET');
    const block = ORCH.slice(i, ORCH.indexOf('    set +e', i)).replace(/\blocal /g, '');
    const out = execFileSync('bash', ['-c',
      `set -u\nlog() { :; }\ntimeout_secs=1800\nEPAM_SECONDS_PER_ITERATION=${SPI}\n${block}\nprintf '%s' "$timeout_secs"`],
      { encoding: 'utf8' });
    expect(Number(out.trim())).toBe(1800);
  });
});

describe('the knobs are loaded where the watchdog can see them', () => {
  it('the PARENT loader reads both, not just claude.sh', () => {
    // claude.sh runs as a subprocess of the watchdog; anything exported there is invisible to
    // the code computing the timeout. This is the documented reason _load_timeout_config exists.
    expect(GUARDS, 'secondsPerIteration is loaded too late to affect the wall')
      .toContain('.timeouts.secondsPerIteration');
    expect(GUARDS).toContain('.timeouts.storyTimeoutMaxSecs');
  });

  it('no seconds are hardcoded in the derivation', () => {
    const i = ORCH.indexOf('    # THE WALL MUST HONOUR THE ITERATION BUDGET');
    const block = ORCH.slice(i, ORCH.indexOf('    set +e', i));
    const code = block.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(/\b(1800|2700|5400|12)\b/.test(code), 'a literal timeout crept into the engine').toBe(false);
  });

  it('the config declares both knobs', () => {
    expect(typeof SPI).toBe('number');
    expect(typeof CAP).toBe('number');
    expect(CAP).toBeGreaterThan(FLOOR);
  });
});
