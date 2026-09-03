/**
 * EVERY VERDICT A PRODUCER EMITS IS HANDLED BY THE CODE THAT CONSUMES IT.
 *
 * Three defects today were the same shape: a value produced in one file and unrecognised in the
 * file that reads it. None needed a run to find. Each needed one question — who calls this, and
 * what does it send — and I answered it from a transcript instead, three times.
 *
 *   project-roster.js accepted `approved`; I decided the reviewer emits `sound` and rewrote the
 *   gate. reviewProjectRoster actually returns `approved`, so the gate then recognised nothing its
 *   caller sends, and the mint failed three attempts. A killed run.
 *
 *   The seam registry declared ladder tiers base/mid/top; every provider set and every launcher
 *   uses medium/high/highest. All 40 seams resolved no model from the ladder they declared.
 *
 *   spec-mode-runner failed a whole review when one batch answered off-schema, discarding batches
 *   that had answered correctly.
 *
 * This asserts the boundaries directly, from the code on both sides — never from a log:
 *
 *   1. every verdict reviewProjectRoster RETURNS is handled by classifyReviewVerdict
 *   2. every ladder tier a seam DECLARES exists in every provider set
 *   3. the aggregate verdicts the review can produce are all handled downstream
 *
 * Producers are read out of their own `verdict:` return statements, consumers out of their own
 * comparisons. Neither side is described here, so neither can drift from what this test believes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const RUNNER_PATH = join(REPO, 'orchestrations/scripts/spec-mode-runner.js');
const ROSTER_PATH = join(REPO, 'orchestrations/scripts/lib/project-roster.js');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');
const CONFIG = join(REPO, 'orchestrations/config');

const RUNNER = readFileSync(RUNNER_PATH, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyReviewVerdict } = require(ROSTER_PATH);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(RUNNER_PATH);

/** Every literal a function returns as `verdict: '<x>'`, read from the function itself. */
function verdictsReturnedBy(source: string, fnSignature: string, span = 20000): string[] {
  const at = source.indexOf(fnSignature);
  if (at < 0) return [];
  const body = source.slice(at, at + span);
  return [...new Set([...body.matchAll(/verdict:\s*['"]([a-z_]+)['"]/g)].map((m) => m[1]))];
}

describe('every verdict a producer emits is handled by its consumer', () => {
  it('BOUNDARY 1: reviewProjectRoster -> classifyReviewVerdict', () => {
    const emitted = verdictsReturnedBy(RUNNER, 'async function reviewProjectRoster({');
    expect(emitted.length, 'no verdicts parsed from the producer — this test would prove nothing')
      .toBeGreaterThan(1);
    const unhandled = emitted.filter(
      (v) => classifyReviewVerdict({ verdict: v, findings: [] }).outcome === 'unrecognised',
    );
    expect(unhandled, `reviewProjectRoster returns ${unhandled.join(', ')} and the gate does not `
      + 'recognise it — the exact defect that killed the 2026-09-01 run').toEqual([]);
  });

  it('BOUNDARY 1b: and its clean verdict is an APPROVAL, not merely recognised', () => {
    // Recognising a word is not the same as acting on it. My broken version classified `approved`
    // as unrecognised, which is "recognised as unknown" — the roster was still discarded.
    const emitted = verdictsReturnedBy(RUNNER, 'async function reviewProjectRoster({');
    expect(emitted, 'the producer no longer returns approved').toContain('approved');
    expect(classifyReviewVerdict({ verdict: 'approved', findings: [] }).outcome).toBe('approved');
  });

  it('BOUNDARY 2: aggregateRosterReview -> classifyReviewVerdict', () => {
    // The aggregate is what reviewProjectRoster builds its answer from. Its verdicts must survive
    // the same boundary.
    const cases = [
      [{ agents: ['a'], part: { verdict: 'sound', findings: [] } }],
      [{ agents: ['a'], part: { verdict: 'defects_found', findings: [] } }],
      [{ agents: ['a'], part: null }],
    ];
    for (const rows of cases) {
      // aggregateRosterReview lives in spec-mode-runner, not project-roster. My first version
      // imported it from the wrong module — the same class of error this file exists to catch.
      const agg = spec.aggregateRosterReview(rows, ['sound', 'defects_found', 'nothing_to_review']);
      expect(classifyReviewVerdict(agg).outcome,
        `the aggregate verdict '${agg.verdict}' is not handled by the gate`).not.toBe('unrecognised');
    }
  });

  it('BOUNDARY 3: seam ladder tier -> provider set ladders', () => {
    const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const profiles = registry.profiles || registry;
    const seams = Object.entries<any>(profiles)
      .filter(([n, p]) => !n.startsWith('_') && !n.startsWith('$') && p && typeof p === 'object' && p.ladder);
    expect(seams.length, 'no seams declare a ladder — this proves nothing').toBeGreaterThan(10);

    const sets = readdirSync(CONFIG).filter((f) => /^llm-defaults\..*\.json$/.test(f));
    const missing: string[] = [];
    for (const f of sets) {
      const tiers = new Set(Object.keys(JSON.parse(readFileSync(join(CONFIG, f), 'utf8')).ladders || {}));
      for (const [name, p] of seams) if (!tiers.has(p.ladder)) missing.push(`${f}: ${name} -> ${p.ladder}`);
    }
    expect(missing, `${missing.length} seam(s) name a tier no provider set defines`).toEqual([]);
  });

  it('BOUNDARY 4: seam ladder tier -> the launcher env convention', () => {
    // The launcher exports EPAM_MODEL_LADDER_<TIER>. A tier the launcher never exports resolves no
    // model however valid it looks in config — which is how base/mid/top survived unnoticed.
    // THE PRODUCER IS model-ladders.sh, NOT THE LAUNCHER. It derives EPAM_MODEL_LADDER_<TIER> from
    // the settings file for EVERY declared tier, so a tier cannot be missed by omission. My first
    // version read the launcher's static export list and flagged `highest` as an orphan — a false
    // positive, and exactly the mistake this file exists to stop: I checked a consumer-shaped thing
    // instead of the actual producer.
    const exporter = readFileSync(join(REPO, 'orchestrations/scripts/lib/model-ladders.sh'), 'utf8');
    expect(exporter, 'model-ladders.sh no longer derives the tier variable name from the settings')
      .toMatch(/EPAM_MODEL_LADDER_\$\(printf/);
    expect(exporter, 'the tiers are no longer read from the ladders block')
      .toMatch(/\.ladders/);

    // What remains checkable here: the launcher's own static export list must not name a tier
    // variable that is malformed. Line 344 read `EPAM_MODEL_LADDER` with no tier suffix.
    const launcher = readFileSync(join(REPO, 'orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
    const malformed = launcher.split('\n')
      .filter((l) => /^\s*export .*\bEPAM_MODEL_LADDER\b(?!_)/.test(l))
      .map((l) => l.trim());
    expect(malformed, 'the launcher exports a variable named EPAM_MODEL_LADDER with no tier suffix')
      .toEqual([]);
  });

  it('BOUNDARY 5: the roster gate is actually wired to the classifier', () => {
    // A classifier nothing calls handles every verdict perfectly and changes nothing.
    const roster = readFileSync(ROSTER_PATH, 'utf8');
    expect(roster, 'project-roster.js does not call classifyReviewVerdict')
      .toMatch(/classifyReviewVerdict\(verdict\)/);
    expect(spec.aggregateRosterReview, 'aggregateRosterReview is not exported for the boundary check')
      .toBeTypeOf('function');
  });
});
