/**
 * resolve_brownfield_effort_floor — REAL execution of the actual function
 * extracted from claude.sh.
 *
 * Brownfield runs on REASONING models (MiniMax-M3, GLM) that emit a large
 * <think> block before any tool call, and that reasoning counts against the
 * output-token budget. The default effort tiers (low=3072, medium=6144) are
 * tuned for greenfield non-reasoning writes and are FAR too small: found live
 * 2026-07-23 (AMSD-1820), every attempt at the default budget was truncated
 * mid-<think> at ~18k tokens and never reached a WriteFile — reported as
 * "deliverables UNCHANGED" 3 straight times; the one attempt that landed the
 * fix only did so once its output reached ~22k. This floor guarantees a
 * reasoning model has room to think AND write in one response.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

function extractFn(name: string): string {
  const start = src.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`function ${name} not found`);
  // find the matching closing brace at column 0 ("}\n")
  const end = src.indexOf('\n}', start);
  return src.slice(start, end + 2);
}
const fnSrc = extractFn('resolve_brownfield_effort_floor');

// Run the extracted function with given starting budgets + env, return the
// resulting STORY_MAX_OUTPUT_TOKENS / STORY_MAX_ITERATIONS.
function run(opts: {
  brownfield: boolean;
  startOut: number;
  startIter: number;
  minOut?: string;
  minIter?: string;
}): { out: number; iter: number } {
  const script = `
log() { :; }
STORY_MAX_OUTPUT_TOKENS=${opts.startOut}
STORY_MAX_ITERATIONS=${opts.startIter}
${fnSrc}
resolve_brownfield_effort_floor "AMSD-1820"
echo "$STORY_MAX_OUTPUT_TOKENS $STORY_MAX_ITERATIONS"
`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.brownfield) env.EPAM_BROWNFIELD = '1'; else delete env.EPAM_BROWNFIELD;
  if (opts.minOut !== undefined) env.EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS = opts.minOut;
  if (opts.minIter !== undefined) env.EPAM_BROWNFIELD_MIN_ITERATIONS = opts.minIter;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim().split(/\s+/).map(Number);
  return { out: out[0], iter: out[1] };
}

describe('resolve_brownfield_effort_floor (real extracted function)', () => {
  it('raises a tiny greenfield-default output budget to the brownfield floor (the truncation fix)', () => {
    const r = run({ brownfield: true, startOut: 6144, startIter: 10 }); // "medium" defaults
    expect(r.out).toBeGreaterThanOrEqual(24576);
    expect(r.iter).toBeGreaterThanOrEqual(12);
  });

  it('raises the smallest (low-tier) budget too', () => {
    const r = run({ brownfield: true, startOut: 3072, startIter: 6 });
    expect(r.out).toBeGreaterThanOrEqual(24576);
    expect(r.iter).toBeGreaterThanOrEqual(12);
  });

  it('is a FLOOR — never lowers an already-larger budget', () => {
    const r = run({ brownfield: true, startOut: 40000, startIter: 30 });
    expect(r.out).toBe(40000);
    expect(r.iter).toBe(30);
  });

  it('does NOTHING in greenfield mode (EPAM_BROWNFIELD unset) — greenfield keeps its tuned small budgets', () => {
    const r = run({ brownfield: false, startOut: 6144, startIter: 10 });
    expect(r.out).toBe(6144);
    expect(r.iter).toBe(10);
  });

  it('honors EPAM_BROWNFIELD_MIN_OUTPUT_TOKENS / MIN_ITERATIONS overrides', () => {
    const r = run({ brownfield: true, startOut: 6144, startIter: 6, minOut: '30000', minIter: '20' });
    expect(r.out).toBe(30000);
    expect(r.iter).toBe(20);
  });

  it('the floor (24576) exceeds the ~18k think-block truncation point that caused the live failure', () => {
    const r = run({ brownfield: true, startOut: 3072, startIter: 6 });
    expect(r.out).toBeGreaterThan(18432); // the truncation ceiling attempts hit before writing
  });
});
