/**
 * A CEILING MUST NEVER BE THE THING THAT ENDS AN ATTEMPT.
 *
 * Derived from the regintel run's own usage traces (usage-trace-<story>.jsonl, one line per model
 * iteration), 2026-09-23:
 *
 *   iterations used across 43 stories : 9 – 120, median ~50
 *   declared effort tiers             : low 6, medium 10, high 15, max 20
 *   => 42 of 43 stories exceeded even `max`; runs only completed because each model override
 *      silently supplied 120–155 instead, so the tiers were decorative while being the number
 *      the engine reported and reasoned about.
 *
 *   6,301 recorded iterations; 85 ended EXACTLY at a declared output ceiling
 *   (62 at 6144 — since raised — 12 at 8192, 7 at 12288, 3 at 16384, 1 at 32768).
 *   An exact value repeating 62 times is a wall, not a model choosing to stop.
 *
 * These assertions are the floors themselves, so a future edit that lowers one fails here rather
 * than in a paid run. They are NOT a claim that the current numbers are ideal — only that nothing
 * may sit below what the evidence already disproved.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const defaults = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));

/** The largest iteration count the traces recorded for a single story. */
const OBSERVED_MAX_ITERATIONS = 120;
/** No seam call survives a slow model in less; topology-router declared 60. */
const SEAM_TIMEOUT_FLOOR = 900;

describe('a ceiling never ends an attempt', () => {
  it('every effort tier allows at least the iterations a story was observed to need', () => {
    for (const [tier, v] of Object.entries<any>(defaults.effortTiers)) {
      expect(v.maxIterations, `effort tier '${tier}' allows ${v.maxIterations} iterations; stories were observed using up to ${OBSERVED_MAX_ITERATIONS}`)
        .toBeGreaterThanOrEqual(40);
    }
    expect(defaults.effortTiers.high.maxIterations, 'the high tier must cover the observed maximum outright')
      .toBeGreaterThanOrEqual(OBSERVED_MAX_ITERATIONS);
  });

  it('no tier sits below an output floor the engine itself declares must not be truncated', () => {
    const floors: Record<string, number> = defaults.outputTokenFloors ?? {};
    const declared = Object.values(floors).filter((n) => typeof n === 'number') as number[];
    const highest = Math.max(...declared);
    for (const [tier, v] of Object.entries<any>(defaults.effortTiers)) {
      expect(v.maxOutputTokens, `tier '${tier}' would truncate a step the engine says must not be`)
        .toBeGreaterThanOrEqual(Math.min(highest, 16384));
    }
  });

  it('a generator is allowed to read before it writes', () => {
    expect(defaults.roleOverrides.generator.maxIterations, 'three iterations is one read and one write with nothing left')
      .toBeGreaterThanOrEqual(12);
  });

  it('no seam declares a timeout a single model call can exceed', () => {
    const tooShort = Object.entries<any>(registry.profiles)
      .filter(([, v]) => typeof v?.timeoutSecs === 'number' && v.timeoutSecs < SEAM_TIMEOUT_FLOOR)
      .map(([k, v]) => `${k}=${v.timeoutSecs}s`);
    expect(tooShort, 'these seams are killed mid-call by their own declaration').toEqual([]);
    expect(registry.defaults.timeoutSecs).toBeGreaterThanOrEqual(SEAM_TIMEOUT_FLOOR);
  });

  it('no seam declares an output budget below the smallest the engine protects', () => {
    const floor = Math.min(...(Object.values<any>(defaults.outputTokenFloors ?? {}).filter((n) => typeof n === 'number') as number[]));
    const tooSmall = Object.entries<any>(registry.profiles)
      .filter(([, v]) => typeof v?.maxOutputTokens === 'number' && v.maxOutputTokens < floor)
      .map(([k, v]) => `${k}=${v.maxOutputTokens}`);
    expect(tooSmall, `below the engine's own floor of ${floor}`).toEqual([]);
  });

  it('the reviewer may spend enough tool calls to reach a verdict', () => {
    // Live 2026-09-22: a review spent its 8 calls, emitted 5,246 characters of analysis inside
    // <think>, finished on tool_calls with no verdict, and was scored changes_requested against
    // the code. A budget that stops the reviewer before it can answer is not a budget that makes
    // it decide.
    expect(registry.profiles['team-lead-review'].maxToolCalls).toBeGreaterThanOrEqual(24);
  });
});
