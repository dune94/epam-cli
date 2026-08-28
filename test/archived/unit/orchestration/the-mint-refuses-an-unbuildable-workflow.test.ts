/**
 * THE MINT REFUSES A WORKFLOW THAT CANNOT RUN, AND A CORRECTED RULE REACHES EVERY AGENT.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * TWO DEFECTS, BOTH FOUND ON 2026-08-13.
 *
 * 1. A STALE MAPPING WINS FOREVER.
 *
 *    writeAgentSeamCrossReference prefers whatever the previous mint recorded:
 *
 *        // A deliberate decision about an agent that still exists survives a re-mint.
 *        // Regenerating the mapping must not silently revert an operator's override.
 *        if (previous[agent] && profiles[previous[agent]]) { next[agent] = previous[agent]; }
 *
 *    The intent is right and the implementation cannot tell an OPERATOR OVERRIDE from a value
 *    the mint itself derived last time. So when the -engineer rule was corrected — ten
 *    implementers had been recorded as instances of the failure analyst — a re-mint would have
 *    kept every stale entry. The fix had to be applied by hand, which means the next corrected
 *    rule will need the same hand.
 *
 *    Provenance separates them: a DERIVED entry is re-derived every mint; an OVERRIDE survives.
 *
 * 2. NOTHING CHECKS THE WORKFLOW IS BUILDABLE.
 *
 *    Archetypes now declare produces/consumes. A roster can therefore contain a consumer whose
 *    required input nobody in that roster produces — a writer waiting for a plan no investigator
 *    was minted to make. That is the shape of every unwinnable story this pipeline has produced,
 *    and it is decidable from the data, before any story runs, with no model involved.
 *
 *    The mint already fails when an agent resolves to no seam, with the right reasoning:
 *    "an unconfigured agent is caught here, before any story runs, not three hours into a run."
 *    A missing PRODUCER is the same class of fault and gets the same treatment.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mint = require(join(ROOT, 'orchestrations/scripts/mint-agents-step.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A registry with two archetypes and a pattern, plus a roster file. */
function fixture(opts: {
  roster: string[];
  previous?: Record<string, string>;
  origin?: Record<string, string>;
  consumes?: any[];
  engineProduces?: string[];
}) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-validate-')); dirs.push(dir);
  const registryPath = join(dir, 'invocation-profiles.json');
  writeFileSync(registryPath, JSON.stringify({
    profiles: {
      'base-investigator': { _what: 'investigates', ladder: 'HIGHEST', produces: 'fix-plan', consumes: [] },
      'base-writer': {
        _what: 'implements the story', ladder: 'HIGHEST', produces: 'implementation',
        consumes: opts.consumes ?? [{ kind: 'fix-plan', required: true }],
      },
    },
    seamPatterns: [
      { match: '-investigator$', seam: 'base-investigator' },
      { match: '-engineer$', seam: 'base-writer' },
    ],
    defaultSeam: 'base-investigator',
    engineProduces: opts.engineProduces ?? [],
    agentSeams: opts.previous ?? {},
    agentSeamOrigin: opts.origin ?? {},
  }, null, 2));

  const profilesPath = join(dir, 'agent-profiles.json');
  const roster: Record<string, string> = {};
  for (const a of opts.roster) roster[a] = 'brief';
  writeFileSync(profilesPath, JSON.stringify({ profiles: roster }, null, 2));
  return { dir, registryPath, profilesPath };
}

describe('the harness drives the real mint code', () => {
  it('a clean roster maps every agent', () => {
    const f = fixture({ roster: ['x-investigator', 'y-engineer'] });
    const xref = mint.writeAgentSeamCrossReference(f.profilesPath, f.registryPath);
    expect(xref['x-investigator']).toBe('base-investigator');
    expect(xref['y-engineer']).toBe('base-writer');
  });
});

describe('A CORRECTED RULE REACHES AGENTS THAT WERE ALREADY MAPPED', () => {
  it('a DERIVED entry is re-derived when the rule changes', () => {
    // The live case: -engineer used to resolve to the analyst. Correcting the rule must reach
    // the ten agents already carrying the old answer, or the correction is cosmetic.
    const f = fixture({
      roster: ['y-engineer'],
      previous: { 'y-engineer': 'base-investigator' },
      origin: { 'y-engineer': 'derived' },
    });
    const xref = mint.writeAgentSeamCrossReference(f.profilesPath, f.registryPath);
    const seam = typeof xref['y-engineer'] === 'string' ? xref['y-engineer'] : xref['y-engineer'].seam;
    expect(seam, 'a stale DERIVED mapping survived a re-mint, so the corrected rule never lands')
      .toBe('base-writer');
  });

  it('an OPERATOR OVERRIDE survives, which is what the stickiness was for', () => {
    const f = fixture({
      roster: ['y-engineer'],
      previous: { 'y-engineer': 'base-investigator' },
      origin: { 'y-engineer': 'override' },
    });
    const xref = mint.writeAgentSeamCrossReference(f.profilesPath, f.registryPath);
    const seam = typeof xref['y-engineer'] === 'string' ? xref['y-engineer'] : xref['y-engineer'].seam;
    expect(seam, 'a deliberate override was silently reverted').toBe('base-investigator');
  });

  it('a legacy bare-string entry is treated as DERIVED, not as an override', () => {
    // Every existing entry is a bare string with no provenance. Reading them as overrides would
    // freeze today's mappings permanently; reading them as derived lets the rules govern again.
    const f = fixture({ roster: ['y-engineer'], previous: { 'y-engineer': 'base-investigator' } });
    const xref = mint.writeAgentSeamCrossReference(f.profilesPath, f.registryPath);
    const seam = typeof xref['y-engineer'] === 'string' ? xref['y-engineer'] : xref['y-engineer'].seam;
    expect(seam).toBe('base-writer');
  });
});

describe('THE MINT REFUSES A ROSTER THAT CANNOT RUN', () => {
  it('a required input nobody in the roster produces FAILS the mint', () => {
    // A writer with no investigator. Decidable from the data, before any story runs.
    const f = fixture({ roster: ['y-engineer'] });
    expect(() => mint.validateWorkflow(f.profilesPath, f.registryPath),
      'a roster whose writer waits for a plan nobody makes was accepted')
      .toThrow(/fix-plan/);
  });

  it('the failure names the consumer AND the missing kind', () => {
    const f = fixture({ roster: ['y-engineer'] });
    let msg = '';
    try { mint.validateWorkflow(f.profilesPath, f.registryPath); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/y-engineer/);
    expect(msg).toMatch(/fix-plan/);
  });

  it('a roster containing a producer PASSES', () => {
    const f = fixture({ roster: ['x-investigator', 'y-engineer'] });
    expect(() => mint.validateWorkflow(f.profilesPath, f.registryPath)).not.toThrow();
  });

  it('an ENGINE-produced input counts as produced', () => {
    const f = fixture({
      roster: ['y-engineer'],
      consumes: [{ kind: 'ticket', required: true }],
      engineProduces: ['ticket'],
    });
    expect(() => mint.validateWorkflow(f.profilesPath, f.registryPath)).not.toThrow();
  });

  it('an OPTIONAL input nobody produces does NOT fail the mint', () => {
    // Optional means the workflow runs without it. Failing here would make every roster carry
    // every producer, which is the opposite of letting a project mint what it needs.
    const f = fixture({
      roster: ['y-engineer'],
      consumes: [{ kind: 'fix-plan', required: true }, { kind: 'nice-to-have' }],
    });
    const g = fixture({
      roster: ['x-investigator', 'y-engineer'],
      consumes: [{ kind: 'fix-plan', required: true }, { kind: 'nice-to-have' }],
    });
    expect(() => mint.validateWorkflow(g.profilesPath, g.registryPath)).not.toThrow();
    expect(() => mint.validateWorkflow(f.profilesPath, f.registryPath)).toThrow(/fix-plan/);
  });
});

describe('THE REAL REGISTRY AND ROSTER ARE BUILDABLE', () => {
  it('the shipped archetypes have no orphan required input', () => {
    // The same check against what actually ships, so this cannot pass on fixtures alone.
    const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
    const produced = new Set<string>([
      ...Object.values(reg.profiles as Record<string, any>).map((v) => String(v.produces)),
      ...(reg.engineProduces || []),
    ]);
    const orphans: string[] = [];
    for (const [name, v] of Object.entries(reg.profiles as Record<string, any>)) {
      for (const c of v.consumes || []) {
        if (c.required && !produced.has(String(c.kind))) orphans.push(`${name} requires '${c.kind}'`);
      }
    }
    expect(orphans, orphans.join('; ')).toEqual([]);
  });
});
