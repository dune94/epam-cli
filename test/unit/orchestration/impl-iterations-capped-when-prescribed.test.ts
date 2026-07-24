/**
 * Impl iteration budget must NOT be inflated when the fix is already prescribed
 * (found live 2026-07-24, AMSD-1820): resolve_brownfield_effort_floor raises
 * STORY_MAX_ITERATIONS to 12 ("reasoning-model headroom — think + write must fit one
 * response"). But when the detective already handed the agent the exact fix + helper,
 * the thinking is done — 12 iterations just wastes ~11 ReAct turns, each re-sending the
 * accumulating conversation → input ballooned to ~169K tokens (in=169644). For a
 * prescribed fix the agent should apply it in a few turns.
 *
 * Fix: when fixSiteAnalysis[].helper is set, do NOT bump iterations to 12; keep the
 * effort-tier default (6). Output-token floor is unaffected (writing still needs room).
 * Drives the REAL bash function extracted from claude.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function extractFn(): string {
  const start = CLAUDE_SH.indexOf('resolve_brownfield_effort_floor() {');
  if (start === -1) throw new Error('function not found');
  // find the matching close brace (function is small, single-level)
  const end = CLAUDE_SH.indexOf('\n}', start);
  return CLAUDE_SH.slice(start, end + 2);
}
const fn = extractFn();

// Run the function against a fixture PRD; return the resulting STORY_MAX_ITERATIONS.
function iterationsFor(helper: string | null): number {
  const dir = mkdtempSync(join(tmpdir(), 'eff-floor-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-1820', fixSiteAnalysis: helper != null ? [{ file: 'src/x.ts', helper }] : [] }] }));
  const script = `
log() { :; }               # stub
export EPAM_BROWNFIELD=1
export PRD_FILE='${prd}'
STORY_MAX_ITERATIONS=6      # effort=low default before the floor runs
STORY_MAX_OUTPUT_TOKENS=3072
${fn}
resolve_brownfield_effort_floor AMSD-1820
echo "$STORY_MAX_ITERATIONS"
`;
  return parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim(), 10);
}

describe('impl iterations are not inflated for a prescribed fix', () => {
  it('helper prescribed → iterations stay at the effort default (<=6), NOT bumped to 12', () => {
    expect(iterationsFor('parseDispatchLineItemKey')).toBeLessThanOrEqual(6);
  });

  it('NO helper (novel work) → iterations bump to 12 (reasoning headroom, unchanged)', () => {
    expect(iterationsFor(null)).toBe(12);
  });
});
