/**
 * EVERY DECLARED INPUT HAS A DECLARED SOURCE.
 *
 * Four defects in one week were one shape: a value declared on one side of a seam and unknown on
 * the other. The roster gate accepted `approved` while I decided the reviewer said `sound`. All 40
 * seams declared ladder tiers base/mid/top that no provider set defines. The prompt generator was
 * told "name no file that does not appear in your context" and given a context with no files. Each
 * cost a paid run. None needed a run to find: each was two declarations that did not meet.
 *
 * invocation-profiles.json already carries the whole graph:
 *
 *   profiles[seam].produces      the kind this seam emits
 *   profiles[seam].consumes[]    the kinds it needs, each optionally required:true
 *   engineProduces[]             kinds the ENGINE supplies — ticket, existing-code, roster …
 *   seamPatterns[]               which seam a minted agent of a given kind maps to
 *
 * so closure is decidable: every consumed kind must be produced by a seam or declared as an engine
 * input. Nothing here restates the graph — both sides are read from the registry, so this cannot
 * drift from what the pipeline believes.
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT, and why the obvious version of it is worthless:
 *
 * "every produced kind is consumed by some seam" reports 21 findings, and essentially all are
 * false. agent-mint declares produces:agent-roster and no seam consumes it — yet the mint runs
 * correctly every time, because its output is read from profiles.json by path. `produces` is a
 * LABEL for the artefact; the data itself travels as files. Asserting closure in that direction
 * measures naming convention, not wiring, and would have buried three real findings under 28
 * phantoms. The check runs one way on purpose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = join(process.cwd(), 'orchestrations/agents/invocation-profiles.json');
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));

const PROFILES: Record<string, any> = reg.profiles || {};
const seams = Object.entries(PROFILES)
  .filter(([n, v]) => !n.startsWith('_') && !n.startsWith('$') && v && typeof v === 'object');

const engineProduces: string[] = Array.isArray(reg.engineProduces) ? reg.engineProduces : [];
const seamPatterns: any[] = Array.isArray(reg.seamPatterns) ? reg.seamPatterns : [];

const producedBySeam = new Set(seams.map(([, v]) => v.produces).filter(Boolean));
const fromEngine = new Set(engineProduces);

/** Every (kind, consumer, required) edge in the graph. */
const edges = seams.flatMap(([name, v]) =>
  (Array.isArray(v.consumes) ? v.consumes : [])
    .filter((c: any) => c && c.kind)
    .map((c: any) => ({ kind: String(c.kind), consumer: name, required: !!c.required })));

describe('the seam graph closes', () => {
  it('the graph is non-empty in both directions — otherwise every assertion below is vacuous', () => {
    expect(seams.length, 'no seams in the registry').toBeGreaterThan(30);
    expect(edges.length, 'no consumes edges parsed — the checks would pass on nothing')
      .toBeGreaterThan(30);
    expect(producedBySeam.size, 'no produces declarations parsed').toBeGreaterThan(20);
    expect(engineProduces.length, 'the engine-input manifest is empty or missing').toBeGreaterThan(0);
  });

  it('EVERY CONSUMED KIND HAS A SOURCE: a seam that produces it, or the engine manifest', () => {
    const orphans = [...new Set(edges.map((e) => e.kind))]
      .filter((k) => !producedBySeam.has(k) && !fromEngine.has(k))
      .map((k) => {
        const cs = edges.filter((e) => e.kind === k);
        const req = cs.some((c) => c.required) ? 'REQUIRED' : 'optional';
        return `  ${k} [${req}] consumed by ${cs.map((c) => c.consumer).join(', ')}`;
      });
    expect(orphans, `${orphans.length} kind(s) are consumed but declared by nobody — no seam `
      + 'produces them and engineProduces does not claim them:\n' + orphans.join('\n')).toEqual([]);
  });

  it('THE ENGINE MANIFEST DOES NOT ROT: everything it claims is actually consumed', () => {
    // An entry nobody consumes is a kind that was renamed or removed, and the stale name is what
    // makes the NEXT orphan look declared. A manifest is only load-bearing while it is accurate.
    const consumedKinds = new Set(edges.map((e) => e.kind));
    const dead = engineProduces.filter((k) => !consumedKinds.has(k) && !producedBySeam.has(k));
    expect(dead, `engineProduces claims ${dead.join(', ')} which no seam consumes`).toEqual([]);
  });

  it('SEAM PATTERN RULES POINT AT SEAMS THAT EXIST AND PRODUCE SOMETHING', () => {
    // rosterCoverageBlock builds "this kind is produced by X — this roster has NOBODY" from these
    // rules. A rule naming a dead seam silently drops a kind out of the coverage report, so the
    // roster reviewer is told a required producer is not needed.
    const broken = seamPatterns
      .filter((r) => r && r.seam)
      .filter((r) => !PROFILES[r.seam] || !PROFILES[r.seam].produces)
      .map((r) => `  kind '${r.kind}' -> seam '${r.seam}'`
        + (PROFILES[r.seam] ? ' (declares no produces)' : ' (no such seam)'));
    expect(broken, `${broken.length} seamPattern rule(s) point at a seam that cannot produce:\n`
      + broken.join('\n')).toEqual([]);
  });

  it('EVERY SEAM DECLARES A CONTRACT — a seam that declares neither cannot be reasoned about', () => {
    const silent = seams
      .filter(([, v]) => !v.produces && !(Array.isArray(v.consumes) && v.consumes.length))
      .map(([n]) => n);
    expect(silent, `${silent.length} seam(s) declare neither produces nor consumes, so nothing can `
      + `check what they need or emit: ${silent.join(', ')}`).toEqual([]);
  });

  it('REQUIRED-INPUT ENFORCEMENT IS HONEST ABOUT ITS OWN REACH', () => {
    // agent-inputs.js opens with "a required input that never arrived is a hard failure ... the
    // safety of the whole migration". It is true only for kinds whose producer declares
    // publishesVia:'agent-io' — deliberately, so an unmigrated producer does not halt the pipeline.
    //
    // This does not demand full migration. It pins the REACH, so the gap stays visible and cannot
    // be mistaken for a guarantee that already holds: the day someone relies on required:true for
    // an unmigrated kind, this line is what tells them it does not fire yet.
    const migrated = seams.filter(([, v]) => v.publishesVia === 'agent-io' && v.produces);
    const enforcedKinds = new Set(migrated.map(([, v]) => String(v.produces)));
    const requiredKinds = [...new Set(edges.filter((e) => e.required).map((e) => e.kind))];
    const unenforced = requiredKinds.filter((k) => !enforcedKinds.has(k));

    expect(requiredKinds.length, 'no required inputs parsed').toBeGreaterThan(0);
    // The recorded reach as of 2026-09-01: 1 producer migrated. Raise this as producers migrate;
    // it may only ever move in that direction.
    expect(migrated.length,
      `required-input enforcement covers ${migrated.length} producer(s); ${unenforced.length} of `
      + `${requiredKinds.length} required kinds are NOT enforced at invocation: `
      + `${unenforced.join(', ')}`).toBeGreaterThanOrEqual(1);
  });
});
