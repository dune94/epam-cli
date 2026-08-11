/**
 * THE NORMALISER MUST NOT DROP A FIELD THE COST RECORD DEPENDS ON.
 *
 * buildRunResultJson emits `usage.cached_input_tokens` — deliberately NOT Anthropic's
 * `cache_read_input_tokens`, because this provider's `input_tokens` ALREADY INCLUDES the cached
 * portion and adding it would double-count every cached token into the budget guard.
 *
 * normalize_provider_json then rebuilt `usage` from scratch with exactly two keys:
 *
 *     usage: { input_tokens: (.usage.inputTokens // 0), output_tokens: (.usage.outputTokens // 0) }
 *
 * so the field was discarded at the seam between the emitter that produced it and the consumer
 * that reads it. claude.sh reads `.usage.cached_input_tokens` and got nothing, recorded
 * cache_read_tokens: 0 in the cost ledger, and printed `cached 0 = 0.0%` on the cost line —
 * while the per-turn usage trace for the SAME attempt measured 98.9% cache utilisation.
 *
 * Live 2026-08-10. The consequence was not a wrong bill but a blind one: caching is the single
 * largest efficiency change made to this pipeline, and every cost figure was unable to see it.
 * A number that silently reads zero is worse than a missing number, because it looks like a
 * measurement.
 *
 * This is the same class as the writer-output manifest and the tri-state gate verdicts: a value
 * that is ABSENT must not render as a legal value. Here absent rendered as "no caching happened".
 *
 * The test EXECUTES the real jq program, extracted from claude.sh, against a fixture in the shape
 * the emitter actually produces.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

/** The jq program the epam branch of normalize_provider_json runs, lifted by anchor. */
function jqProgram(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf(`jq -s '[.[] | select(has("result"))]`);
  const end = src.indexOf(`' "$raw_file"`, start);
  if (start === -1 || end === -1) throw new Error('normaliser anchors not found — extraction stale');
  return src.slice(src.indexOf("'", start) + 1, end);
}

/** Run that program over a raw provider line, as the pipeline does. */
function normalise(raw: Record<string, unknown>): Record<string, never> {
  const out = execFileSync('jq', ['-s', jqProgram()], {
    input: JSON.stringify(raw), encoding: 'utf8',
  });
  return JSON.parse(out);
}

/** The emitter's real shape: camelCase counts, snake_case cached key, per buildRunResultJson. */
const emitted = (cached?: number) => ({
  result: 'done',
  cost_usd: 1.5,
  usage: {
    inputTokens: 7_084_735,
    outputTokens: 36_687,
    totalTokens: 7_121_422,
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
  },
});

describe('the extraction is live', () => {
  it('the jq program can be lifted and is non-trivial', () => {
    expect(jqProgram().length).toBeGreaterThan(80);
  });

  it('the counts it already carried still survive', () => {
    const r = normalise(emitted(6_800_000)) as never as { usage: Record<string, number> };
    expect(r.usage.input_tokens).toBe(7_084_735);
    expect(r.usage.output_tokens).toBe(36_687);
  });
});

describe('THE DEFECT: cached tokens survive normalisation', () => {
  it('a cached count present on the way in is present on the way out', () => {
    const r = normalise(emitted(6_800_000)) as never as { usage: Record<string, number> };
    expect(
      r.usage.cached_input_tokens,
      'the normaliser rebuilt usage with only two keys, so the cost ledger recorded 0 cached ' +
      'tokens for an attempt that was 98.9% cached',
    ).toBe(6_800_000);
  });

  it('a zero cached count is preserved as zero, not dropped', () => {
    // Zero is a real measurement — an uncached route — and must be distinguishable from absent.
    const r = normalise(emitted(0)) as never as { usage: Record<string, number> };
    expect(r.usage.cached_input_tokens).toBe(0);
  });

  it('ABSENT stays absent rather than becoming zero', () => {
    // A provider that reports nothing about caching has not reported zero caching. The consumer
    // defaults it for display; the record must not assert a measurement that was never made.
    const r = normalise(emitted(undefined)) as never as { usage: Record<string, unknown> };
    expect(
      r.usage.cached_input_tokens ?? null,
      'an unmeasured value was recorded as a measured zero — the defect this pipeline keeps ' +
      'reproducing',
    ).toBeNull();
  });
});
