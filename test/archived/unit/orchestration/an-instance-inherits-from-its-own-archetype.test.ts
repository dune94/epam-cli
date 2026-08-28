/**
 * A MINTED AGENT MUST RESOLVE TO THE ARCHETYPE IT ACTUALLY IS.
 *
 * WRITTEN BEFORE THE FIX.
 *
 * agentSeams maps a minted agent to a base profile. Today that map is used for ONE purpose —
 * "which invocation settings does this agent run with" — and the entries were chosen on that
 * basis alone. The registry says so in its own words:
 *
 *     -engineer$  ->  impl-failure-analyst
 *     "implementer seam: high ladder, matching the story writer tier"
 *
 * So ten implementers — typescript-engineer, billing-engineer, ui-engineer and the rest — are
 * recorded as instances of the FAILURE ANALYST, because its ladder happened to be the tier
 * wanted. An engineer writes code; an analyst diagnoses why code failed.
 *
 * That is inert today: claude.sh invokes the writer through its own rung ladder and never calls
 * invoke_agent or seam_ladder_export, so nothing reads the mapping for an engineer.
 *
 * IT STOPS BEING INERT the moment base profiles carry `template`, `produces` and `consumes` and
 * instances inherit them — an engineer would inherit the analyst's prompt template, publish the
 * analyst's kind, and consume the analyst's inputs. A design cannot rest on a map that means
 * something else.
 *
 * THE ROOT CAUSE is the gap underneath it: THERE IS NO IMPLEMENTER ARCHETYPE. Seventeen base
 * profiles cover reviewing, investigating, diagnosing, estimating and authoring — and not the
 * agent that writes the code. The pattern pointed somewhere plausible because there was nowhere
 * correct to point.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeam } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));

const reg = () => JSON.parse(readFileSync(REGISTRY, 'utf8'));

describe('the registry is loadable and total', () => {
  it('every seamPattern points at a profile that exists', () => {
    const r = reg();
    for (const p of r.seamPatterns || []) {
      expect(Object.keys(r.profiles), `pattern ${p.match} points at a profile that is not defined`)
        .toContain(p.seam);
    }
  });

  it('the default seam exists too', () => {
    const r = reg();
    expect(Object.keys(r.profiles)).toContain(r.defaultSeam);
  });
});

describe('THERE IS AN ARCHETYPE FOR THE AGENT THAT WRITES THE CODE', () => {
  it('a base profile exists for implementing a story', () => {
    // Seventeen archetypes and none of them implements anything. Everything downstream — the
    // template a writer renders, the kind it publishes, the inputs it declares — needs a base to
    // hang on.
    const profiles = reg().profiles;
    // NOT a bare /implementation/ match: "Diagnoses why an implementation attempt failed"
    // satisfies that, so the analyst made this pass before the archetype existed. The archetype
    // must describe DOING the work, and must not describe diagnosing it.
    const implementers = Object.entries(profiles).filter(([, v]: any) => {
      const what = String(v._what || '');
      return /implements|writes the code|authors the change|story writer/i.test(what)
        && !/diagnos/i.test(what);
    });
    expect(implementers.length,
      'no base profile describes implementing a story — engineers have no archetype to inherit')
      .toBeGreaterThan(0);
  });
});

describe('AN IMPLEMENTER IS NOT A DIAGNOSTICIAN', () => {
  const diagnoses = (seam: string) =>
    /diagnos|why .*failed|failure analyst/i.test(String((reg().profiles as any)[seam]?._what || ''));

  it('a minted engineer does not resolve to a diagnosing profile', () => {
    const seam = resolveSeam('typescript-engineer', REGISTRY);
    expect(diagnoses(seam),
      `typescript-engineer resolves to '${seam}', whose stated job is diagnosis — an engineer writes code`)
      .toBe(false);
  });

  it('nor does an engineer minted under a name nobody has seen before', () => {
    // The pattern, not the exact-map entry: the next project will mint names this registry has
    // never met, and they must land somewhere correct by rule rather than by luck.
    const seam = resolveSeam('payments-integration-engineer', REGISTRY);
    expect(diagnoses(seam),
      `an unseen engineer resolves to '${seam}', whose stated job is diagnosis`)
      .toBe(false);
  });

  it('and an ANALYST still does resolve to the diagnosing profile', () => {
    // The counterweight: fixing the engineer mapping must not break the one that was right.
    expect(diagnoses(resolveSeam('impl-failure-analyst', REGISTRY))).toBe(true);
    expect(diagnoses(resolveSeam('some-new-analyst', REGISTRY))).toBe(true);
  });
});

describe('THE REGISTRY SAYS WHAT THE MAP MEANS', () => {
  it('it records that a seam is the archetype, not a bag of settings', () => {
    // The entries were chosen as "settings that look about right", and the next person to read
    // them will assume archetype — as the inheritance design does. Whichever it is, it has to
    // be written down, because the two readings pick different profiles.
    const raw = readFileSync(REGISTRY, 'utf8');
    expect(raw, 'nothing in the registry states what agentSeams means')
      .toMatch(/archetype/i);
  });
});
