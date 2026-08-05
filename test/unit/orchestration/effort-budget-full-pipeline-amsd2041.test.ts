/**
 * End-to-end integration: the REAL call sequence claude.sh actually runs for
 * every story — resolve_effort_settings -> resolve_generator_settings ->
 * resolve_test_engineer_effort_floor -> resolve_brownfield_effort_floor
 * (see the real call site, claude.sh:6890-6900) — driven together, not each
 * function tested in isolation.
 *
 * The individual-function unit tests (cpa-effort-tier-upgrades-iterations,
 * brownfield-effort-floor-scales-with-scope) each proved their OWN function
 * correct in isolation. Neither proves the four functions compose correctly
 * when chained in the real order — a later function could silently reset an
 * earlier one's upgrade, or the two floors could fight each other. This
 * drives all four together against the REAL AMSD-2041 shape (effort:"low"
 * from Jira with no ACs; CPA gate="review"/1.3x on the upexpress lane; 2
 * fixSiteAnalysis sites; 4 uncovered verification criteria) and asserts the
 * budget the implementer would ACTUALLY receive on a real run.
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

// The real functions, real order.
const FNS = [
  'resolve_effort_settings',
  'resolve_generator_settings',
  'resolve_test_engineer_effort_floor',
  'resolve_brownfield_effort_floor',
].map(extractFn).join('\n\n');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runPipeline(story: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): { iter: number; outTok: number } {
  const dir = mkdtempSync(join(tmpdir(), 'full-pipeline-'));
  dirs.push(dir);
  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-2041', ...story }] }));

  const script = `
log() { :; }
export PRD_FILE='${prd}'
AUTOMATION_DIR='${_AUTOMATION}'
${_loaderFn}
load_llm_settings_json
${FNS}
resolve_effort_settings AMSD-2041
resolve_generator_settings AMSD-2041
resolve_test_engineer_effort_floor AMSD-2041
resolve_brownfield_effort_floor AMSD-2041
echo "$STORY_MAX_ITERATIONS $STORY_MAX_OUTPUT_TOKENS"
`;
  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, ...env },
  }).trim().split(/\s+/).map(Number);
  return { iter: out[0], outTok: out[1] };
}

// Budgets moved to orchestrations/config/llm-defaults.json — run the real loader first,
// as the pipeline does, or the extracted functions see no configuration at all.
const _AUTOMATION = join(__dirname, '../../../orchestrations');
const _loaderFn = extractFn('load_llm_settings_json');

describe('full effort-budget pipeline, real call order — AMSD-2041 shapes', () => {
  it('the PRE-FIX shape (effort:low, no cpaEffortTier, no coverage data) reproduces the exact live under-budget (6-12 iter)', () => {
    const r = runPipeline({ effort: 'low' }, { EPAM_BROWNFIELD: '1' });
    // This is what actually happened on the live run before today's fixes —
    // pinned here so a future change can't silently regress back to it
    // without this test explicitly changing.
    expect(r.iter).toBeLessThanOrEqual(12);
  });

  it('the REAL upexpress-lane shape (cpaEffortTier=high from gate=review) reaches 15+ iterations end-to-end', () => {
    const r = runPipeline({
      effort: 'low', // untouched Jira/CPA-input classification
      cpaEffortTier: 'high', // what CPA actually wrote for upexpress (gate=review, 1.3x)
    }, { EPAM_BROWNFIELD: '1' });
    expect(r.iter).toBeGreaterThanOrEqual(15);
  });

  it('the REAL gotransit-lane shape (CPA inference failed to parse, cpaEffortTier absent) still gets the detective-coverage upgrade independently', () => {
    // On the live run, gotransit's CPA call hit a JSON-parse failure and fell
    // back to the unchanged formula baseline — no cpaEffortTier was ever
    // written for that lane. The detective's own coverage signal must still
    // be able to upgrade the budget on its own, independent of CPA succeeding.
    const r = runPipeline({
      effort: 'low',
      fixSiteAnalysis: [
        { file: 'src/services/contentstack.ts', helper: '' },
        { file: 'src/context/ContentstackContext.tsx', helper: '' },
      ],
      fixSiteAnalysisCoverage: {
        complete: false,
        uncoveredVerificationCriteria: [
          'SDK installed', 'preview API route', 'getStaticProps forwarding', 'unit tests',
        ],
      },
    }, { EPAM_BROWNFIELD: '1' });
    // 8 + 4*2 + 3*4 = 28 via the scaling formula, well above the old 6-12 floor
    expect(r.iter).toBeGreaterThanOrEqual(24);
  });

  it('BOTH signals together (CPA upgrade AND scope-scaled floor) do not fight — the larger of the two wins, never averaged down', () => {
    const r = runPipeline({
      effort: 'low',
      cpaEffortTier: 'medium', // -> 10 from resolve_effort_settings
      fixSiteAnalysis: [
        { file: 'a.ts', helper: '' }, { file: 'b.ts', helper: '' }, { file: 'c.ts', helper: '' },
      ],
      fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['x', 'y', 'z', 'w'] },
    }, { EPAM_BROWNFIELD: '1' });
    // scaled floor: 8 + 4*3 + 3*4 = 32 (capped at 30) > the CPA-only 10 -> the brownfield
    // floor's raise-only guard must win, not silently cap back down to 10.
    expect(r.iter).toBe(30);
  });

  it('output-token floor is unaffected by scope scaling — stays the flat 24576 brownfield floor', () => {
    const r = runPipeline({
      effort: 'low',
      fixSiteAnalysis: [{ file: 'a.ts', helper: '' }, { file: 'b.ts', helper: '' }],
      fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['x', 'y', 'z', 'w'] },
    }, { EPAM_BROWNFIELD: '1' });
    expect(r.outTok).toBe(24576);
  });

  it('greenfield (EPAM_BROWNFIELD unset) ignores all of this — cpaEffortTier still upgrades iterations via resolve_effort_settings, but the brownfield-only floor/output bump never fires', () => {
    const r = runPipeline({ effort: 'low', cpaEffortTier: 'high' }, {});
    expect(r.iter).toBe(15); // from resolve_effort_settings's own tier upgrade, greenfield-safe
    expect(r.outTok).toBe(6144); // "high" tier's own default, NOT the brownfield 24576 floor
  });
});
