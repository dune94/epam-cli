/**
 * resolve_effort_settings — CPA's own complexity judgment and the detective's
 * coverage check must reach the REAL iteration/token budget, not just the
 * model-escalation ladder.
 *
 * Live AMSD-2041, 2026-08-01: CPA flagged gate="review"/complexityAdjustment
 * 1.3x, explicitly citing "Six broad verification criteria imply scope beyond
 * labeled 'low' effort" — but that signal only ever fed `ladderTier` (which
 * MODEL handles escalation retries). STORY_MAX_ITERATIONS stayed keyed to the
 * story's untouched "low" input classification, because `effort` — the ONLY
 * field resolve_effort_settings() reads — is just an echo-through of CPA's
 * input, never re-derived from CPA's own complexityAdjustment/gate output.
 * Same gap for the detective's fixSiteAnalysisCoverage: a prescription known
 * to leave verification criteria unaddressed still got the "low" budget.
 *
 * Fix: contextualize-stories.sh now also persists cpaEffortTier (the same
 * categorical signal already computed for ladderTier); this test drives the
 * REAL resolve_effort_settings() function extracted from claude.sh to prove
 * it reads cpaEffortTier / fixSiteAnalysisCoverage.complete and upgrades
 * STORY_MAX_ITERATIONS accordingly — upgrade-only, same discipline as the
 * existing EPAM_EFFORT_TIER self-heal path.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function extractFn(name: string): string {
  const start = CLAUDE_SH.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const end = CLAUDE_SH.indexOf('\n}', start);
  return CLAUDE_SH.slice(start, end + 2);
}
const fn = extractFn('resolve_effort_settings');
const loaderFn = extractFn('load_llm_settings_json');
// resolve_effort_settings no longer carries literal budgets: the tiers moved to
// orchestrations/config/llm-defaults.json (project-overridable in llm-settings.json), so a
// harness that runs the function ALONE leaves every budget unset. Running the real loader
// first is what the pipeline does, and keeps this test measuring the upgrade logic rather
// than the absence of configuration.
const AUTOMATION = join(__dirname, '../../../orchestrations');

function iterationsFor(story: Record<string, unknown>): { iter: number; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'effort-tier-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-2041', effort: 'low', ...story }] }));
  const script = `
LOG_FILE=$(mktemp)
log() { echo "$1" >> "$LOG_FILE"; }
export PRD_FILE='${prd}'
AUTOMATION_DIR='${AUTOMATION}'
${loaderFn}
load_llm_settings_json
${fn}
resolve_effort_settings AMSD-2041
echo "ITER=$STORY_MAX_ITERATIONS"
echo "---LOG---"
cat "$LOG_FILE"
`;
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  const iterMatch = out.match(/ITER=(\d+)/);
  return { iter: iterMatch ? parseInt(iterMatch[1], 10) : NaN, log: out.split('---LOG---')[1] || '' };
}

describe('resolve_effort_settings — CPA gate/complexityAdjustment and coverage upgrade the real budget (real extracted function)', () => {
  it('cpaEffortTier=high upgrades a "low" story to 15 iterations (the real AMSD-2041 upexpress lane shape)', () => {
    const r = iterationsFor({ cpaEffortTier: 'high' });
    expect(r.iter).toBe(15);
    expect(r.log).toMatch(/EffortTier\[CPA\].*upgrading low.*high/);
  });

  it('cpaEffortTier=medium upgrades a "low" story to 10 iterations', () => {
    const r = iterationsFor({ cpaEffortTier: 'medium' });
    expect(r.iter).toBe(10);
  });

  it('incomplete fixSiteAnalysisCoverage alone upgrades "low" to at least "medium" (10 iterations)', () => {
    const r = iterationsFor({ fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['x'] } });
    expect(r.iter).toBe(10);
  });

  it('complete coverage with no cpaEffortTier does nothing — stays at the "low" default (6 iterations)', () => {
    const r = iterationsFor({ fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] } });
    expect(r.iter).toBe(6);
  });

  it('is upgrade-only: cpaEffortTier=low on an already-"high" story does NOT downgrade it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effort-tier-'));
    dirs.push(dir);
    const prd = join(dir, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-2041', effort: 'high', cpaEffortTier: 'low' }] }));
    const script = `
log() { :; }
export PRD_FILE='${prd}'
AUTOMATION_DIR='${AUTOMATION}'
${loaderFn}
load_llm_settings_json
${fn}
resolve_effort_settings AMSD-2041
echo "$STORY_MAX_ITERATIONS"
`;
    const iter = parseInt(execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim(), 10);
    expect(iter).toBe(15);
  });

  it('is backward compatible: no cpaEffortTier / no fixSiteAnalysisCoverage field at all behaves exactly as before', () => {
    const r = iterationsFor({});
    expect(r.iter).toBe(6); // effort:"low" default, unchanged
  });

  it('missing coverage field defaults to complete (no false alarm on stories the detective never ran for)', () => {
    const r = iterationsFor({ cpaEffortTier: '' });
    expect(r.iter).toBe(6);
  });
});
