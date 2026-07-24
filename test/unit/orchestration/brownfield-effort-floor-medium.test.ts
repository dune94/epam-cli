/**
 * Brownfield reasoning effort must not be LOW just because a ticket lacks story points
 * (found live 2026-07-24, AMSD-1820): storyPoints=null → pointsToEffort(0) → "low", so a
 * correctness-critical defect ran the impl at LOW effort → inconsistent/wrong results. A
 * ticket's story points say nothing about how carefully a brownfield fix must be reasoned.
 * Floor brownfield effort at MEDIUM (env-overridable). Greenfield is unchanged; an explicit
 * higher effort (medium/high) is preserved.
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
  const start = CLAUDE_SH.indexOf('resolve_reasoning_effort_from_story() {');
  const end = CLAUDE_SH.indexOf('\n}', start);
  return CLAUDE_SH.slice(start, end + 2);
}
const fn = extractFn();

function effortFor(storyEffort: string, brownfield: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'eff-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S', reasoningEffort: storyEffort }] }));
  const script = `
log() { :; }
${brownfield ? 'export EPAM_BROWNFIELD=1' : 'unset EPAM_BROWNFIELD'}
export PRD_FILE='${prd}'
${fn}
resolve_reasoning_effort_from_story S
echo "\${EPAM_REASONING_EFFORT:-unset}"
`;
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

describe('brownfield effort floor', () => {
  it('brownfield + low → floored to medium', () => {
    expect(effortFor('low', true)).toBe('medium');
  });
  it('brownfield + high → stays high (explicit higher effort preserved)', () => {
    expect(effortFor('high', true)).toBe('high');
  });
  it('greenfield + low → stays low (unchanged)', () => {
    expect(effortFor('low', false)).toBe('low');
  });
});
