/**
 * COMPACTION AND PROMPT CACHING ARE IN DIRECT OPPOSITION, AND NOBODY KNEW.
 *
 * compressHistory REPLACES the message array with a one-line summary:
 *
 *     messages = await compressHistory(messages, ...)
 *       -> [{ role: 'user', content: '[Previous conversation summary]: ...' }]
 *
 * That destroys the cacheable prefix. Measured 2026-08-10, a stable prefix is served ~99% from
 * cache on every route that caches (MiniMax-M3 99.8%, z-ai/glm-5.2 99.6%, kimi-k3 98.2%), so
 * compacting to save tokens forfeits the discount on everything accumulated and then pays full
 * price to rebuild it.
 *
 * The `autoCompressEveryNIterations` trigger was the worst of it: it fired on ITERATION COUNT
 * regardless of context size, so a writer sitting at 40K tokens — comfortably inside every
 * model's window — was compacted anyway. Live run 20260810T095545 reported cache_read_tokens=0
 * across 6.6M input tokens while running `compaction=every 25 iter`.
 *
 * These settings were all tuned when every token cost full price. Compaction is now an OVERFLOW
 * guard, not a token-saving device.
 *
 * The per-turn usage trace exists because the aggregate cannot show WHERE utilisation collapses.
 * The hypothesis predicts a drop to zero on the turn after each compaction; the trace makes that
 * measurable instead of inferred.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CFG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'));
const RUNNER = readFileSync(join(ROOT, 'src/agent/AgentRunner.ts'), 'utf8');
const CLAUDE = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const MO = CFG.modelOverrides as Record<string, Record<string, unknown>>;

/** Routes measured 2026-08-10 as serving a stable prefix from cache. */
const CACHING = ['minimax-m3', 'glm-5.2', 'kimi-k3'];
/** Measured at 0% — compaction costs it nothing. */
const NON_CACHING = ['kimi-k2.5'];

describe('a caching model is not compacted on iteration count', () => {
  for (const m of CACHING) {
    it(`${m} has no autoCompressEveryNIterations`, () => {
      expect(
        MO[m]?.autoCompressEveryNIterations,
        `${m} caches, and an iteration-count trigger discards that discount regardless of how ` +
        'small the context actually is',
      ).toBeUndefined();
    });
  }

  it('a NON-caching model may keep an aggressive trigger — it has nothing to lose', () => {
    for (const m of NON_CACHING) {
      expect(MO[m]?.autoCompressEveryNIterations).toBeGreaterThan(0);
    }
  });
});

describe('the token threshold is an overflow margin, not a savings target', () => {
  for (const m of CACHING.filter((x) => x !== 'kimi-k3')) {
    it(`${m} compacts well above the old 128K savings-era threshold`, () => {
      expect(MO[m]?.autoCompressAt as number).toBeGreaterThan(128_000);
    });
  }

  it('every caching model still HAS a threshold — overflow is a hard failure, not a costly one', () => {
    for (const m of CACHING) expect(typeof MO[m]?.autoCompressAt).toBe('number');
  });
});

describe('tool output is bounded, because history is re-sent every turn', () => {
  it('the truncation constant is small enough to bound history growth', () => {
    // THIS TEST ASSERTED THE OPPOSITE EARLIER THE SAME DAY, and the reasoning was wrong.
    //
    // It required the constant to be RAISED above 8192, on the argument that truncating a tool
    // result "mutates content inside the cacheable prefix" and a larger stable result is cheaper
    // than a smaller one that shifts the prefix. Truncation is DETERMINISTIC: the same result cut
    // the same way yields the same prefix, merely shorter. Nothing shifts.
    //
    // What the raise did do was double the rate history grows, and history is re-sent on every
    // turn of the loop. Measured 2026-08-10: a 120-turn attempt sent 7.5M input tokens, ~5.4M of
    // it accumulated history, with per-turn growth spiking to 53,721 tokens — reachable only by
    // several large tool results landing in one turn. Caching discounts that traffic; it does not
    // make it free, and no cached rate is wired into the cost model at all.
    const m = /const DEFAULT_MAX_TOOL_OUTPUT_CHARS = ([\d_]+);/.exec(RUNNER);
    expect(m, 'the truncation constant moved').toBeTruthy();
    expect(Number((m as RegExpExecArray)[1].replace(/_/g, ''))).toBeLessThanOrEqual(8192);
  });
});

describe('per-turn usage is traceable, so the collapse point is measurable', () => {
  it('AgentRunner writes a trace line per turn when asked', () => {
    expect(RUNNER).toContain('EPAM_USAGE_TRACE_FILE');
  });

  it('the line carries cached tokens AND whether that turn compacted', () => {
    const i = RUNNER.indexOf('EPAM_USAGE_TRACE_FILE');
    const block = RUNNER.slice(i, i + 900);
    expect(block).toContain('cachedInputTokens');
    // The FIELD, not just the word: `compactedThisTurn` also appears in the reset that follows,
    // so a loose match survived deleting the field from the emitted record.
    expect(block, 'without this the trace cannot attribute a cache collapse to compaction')
      .toMatch(/compacted:\s*this\.compactedThisTurn/);
    expect(block).toContain('iteration');
  });

  it('cached is null when the provider said nothing — distinct from a reported zero', () => {
    const i = RUNNER.indexOf('EPAM_USAGE_TRACE_FILE');
    expect(RUNNER.slice(i, i + 900)).toMatch(/cachedInputTokens:\s*response\.usage\.cachedInputTokens\s*\?\?\s*null/);
  });

  it('the compaction flag is set where compaction actually happens', () => {
    const i = RUNNER.indexOf('iterationAtLastCompress = this.iterationCount;');
    expect(i).toBeGreaterThan(-1);
    expect(RUNNER.slice(i, i + 120)).toContain('compactedThisTurn = true');
  });

  it('tracing is opt-in — an unset env var writes nothing', () => {
    const i = RUNNER.indexOf('EPAM_USAGE_TRACE_FILE');
    expect(RUNNER.slice(Math.max(0, i - 120), i + 60)).toMatch(/if \(process\.env\.EPAM_USAGE_TRACE_FILE\)/);
  });

  it('and it can never take the run down with it', () => {
    const i = RUNNER.indexOf('EPAM_USAGE_TRACE_FILE');
    expect(RUNNER.slice(i, i + 900)).toMatch(/catch\s*\{/);
  });

  it('the pipeline wires a trace file per attempt', () => {
    expect(CLAUDE).toContain('EPAM_USAGE_TRACE_FILE="${LOG_DIR}/usage-trace-${story_id}.jsonl"');
  });
});
