/**
 * _cap_brownfield_iterations_ceiling — the ladder's rung-based +5 iteration
 * bumps happen AFTER resolve_brownfield_effort_floor's own ceiling already
 * ran, so a story whose floor is already at the cap (e.g. 30) could still
 * reach 45 by rung 3 (30 + 5 + 5 + 5) — exactly the context-window risk the
 * floor's own ceiling exists to prevent. Real execution of the actual
 * function extracted from claude.sh, plus confirmation that all 3 real
 * call sites in the ladder's rung case-statement are wired to it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

function extractFn(name: string): string {
  const start = CLAUDE_SH.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = CLAUDE_SH.indexOf('\n}', start);
  return CLAUDE_SH.slice(start, end + 2);
}
const fn = extractFn('_cap_brownfield_iterations_ceiling');

function run(startIter: number, env: NodeJS.ProcessEnv = {}): number {
  const script = `
log() { :; }
${fn}
STORY_MAX_ITERATIONS=${startIter}
_cap_brownfield_iterations_ceiling "TestRung"
echo "$STORY_MAX_ITERATIONS"
`;
  return parseInt(execFileSync('bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1', ...env },
  }).trim(), 10);
}

describe('_cap_brownfield_iterations_ceiling (real extracted function)', () => {
  it('caps a value above the default ceiling (30) down to it', () => {
    expect(run(45)).toBe(30);
  });

  it('leaves a value at or below the ceiling untouched', () => {
    expect(run(30)).toBe(30);
    expect(run(20)).toBe(20);
  });

  it('respects EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS override', () => {
    expect(run(45, { EPAM_BROWNFIELD_MAX_SCALED_ITERATIONS: '15' })).toBe(15);
  });

  it('does NOTHING outside brownfield mode (EPAM_BROWNFIELD unset)', () => {
    const script = `
log() { :; }
${fn}
STORY_MAX_ITERATIONS=45
_cap_brownfield_iterations_ceiling "TestRung"
echo "$STORY_MAX_ITERATIONS"
`;
    const env = { ...process.env };
    delete env.EPAM_BROWNFIELD;
    const out = parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8', env }).trim(), 10);
    expect(out).toBe(45);
  });
});

describe('the ladder\'s 3 rung transitions all call the ceiling cap (real source check)', () => {
  it('Rung1, Rung2, and Rung3 each call _cap_brownfield_iterations_ceiling right after their +5 bump', () => {
    // 2026-08-01: a second, symptom-driven bump (_iteration_exhaustion_bump)
    // was added alongside CPA's estimate-based one — see
    // iteration-exhaustion-bump.test.ts. Same 3 call sites, same shape.
    const bumpMarker = 'STORY_MAX_ITERATIONS=$(( STORY_MAX_ITERATIONS + $(_brownfield_rung_bump "$story_id") + $(_iteration_exhaustion_bump "$story_id") ))';
    let idx = -1;
    let count = 0;
    // eslint-disable-next-line no-cond-assign
    while ((idx = CLAUDE_SH.indexOf(bumpMarker, idx + 1)) !== -1) {
      count++;
      const nextLines = CLAUDE_SH.slice(idx, idx + 300);
      expect(nextLines, `bump #${count} at offset ${idx} has no ceiling call within the next few lines`)
        .toMatch(/_cap_brownfield_iterations_ceiling/);
    }
    expect(count, 'expected exactly 3 rung +5 bumps in the ladder — has the ladder shape changed?').toBe(3);
  });
});
