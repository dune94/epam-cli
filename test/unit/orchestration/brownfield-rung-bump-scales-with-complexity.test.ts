/**
 * _brownfield_rung_bump — the ladder's rung-transition increment used to be
 * a flat +5 regardless of story complexity. CPA's brownfield-only
 * iterationEstimate (an ABSOLUTE turn count, 1-500 — cpa-system.md
 * "Iteration Estimate") already estimates exactly how much real work is
 * left; the bump now scales as 10% of that estimate, floored at 5 (a story
 * CPA judges as needing 200 turns overall should not still get the SAME +5
 * nudge per rung as a 1-turn story). Greenfield keeps the flat +5 — this
 * signal doesn't exist there.
 *
 * Redesigned 2026-08-01 from a 1.0-3.0x multiplier applied to a flat base of
 * 5: that range couldn't span "5 for a bug fix" to "200 for a large
 * multi-layer change," a real ~40x gap.
 *
 * Real execution of the actual function extracted from claude.sh.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

function extractFn(name: string): string {
  const start = CLAUDE_SH.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = CLAUDE_SH.indexOf('\n}', start);
  return CLAUDE_SH.slice(start, end + 2);
}
const fn = extractFn('_brownfield_rung_bump');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function bumpFor(iterationEstimate: number | undefined, brownfield = true): number {
  const dir = mkdtempSync(join(tmpdir(), 'rung-bump-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  const story: Record<string, unknown> = { id: 'X-1' };
  if (iterationEstimate !== undefined) story.cpaIterationEstimate = iterationEstimate;
  writeFileSync(prd, JSON.stringify({ stories: [story] }));
  const env: NodeJS.ProcessEnv = { ...process.env, PRD_FILE: prd };
  if (brownfield) env.EPAM_BROWNFIELD = '1'; else delete env.EPAM_BROWNFIELD;
  const script = `${fn}\n_brownfield_rung_bump X-1`;
  return parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim(), 10);
}

describe('_brownfield_rung_bump (real extracted function)', () => {
  it('estimate 1 (or absent) -> floored at +5 (unchanged default)', () => {
    expect(bumpFor(1)).toBe(5);
  });

  it('estimate 50 -> +5 (10% of 50, still at the floor)', () => {
    expect(bumpFor(50)).toBe(5);
  });

  it('estimate 100 -> +10 (10% of 100)', () => {
    expect(bumpFor(100)).toBe(10);
  });

  it('estimate 200 (the user\'s own example for a large brownfield change) -> +20', () => {
    expect(bumpFor(200)).toBe(20);
  });

  it('no cpaIterationEstimate field at all defaults to 1 -> +5 (backward compatible)', () => {
    expect(bumpFor(undefined)).toBe(5);
  });

  it('clamps an out-of-range value (e.g. malformed data) to the 500 ceiling rather than trusting it raw', () => {
    expect(bumpFor(99999)).toBe(50); // clamped to 500 -> 10% = 50, not +9999.9
  });

  it('greenfield (EPAM_BROWNFIELD unset) always gets the flat +5, even with an estimate present', () => {
    expect(bumpFor(200, false)).toBe(5);
  });
});
