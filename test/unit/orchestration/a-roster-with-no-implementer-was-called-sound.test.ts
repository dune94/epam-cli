/**
 * A ROSTER THAT CANNOT IMPLEMENT ANYTHING WAS REVIEWED AND CALLED SOUND.
 *
 * Live 2026-08-17, run 20260817T171347Z. The mint produced:
 *
 *     minted: transit-fare-engineer      kind: investigator  codeline: mocka
 *     minted: transit-schedule-engineer  kind: investigator  codeline: mockb
 *     projectRoles: []                   projectInvestigators: 2
 *
 *     [mint-step] roster review (cycle 1): sound — 0 finding(s), 0 blocking
 *     [mint-step] FAILED: [assign] no project implementation roles are registered
 *
 * Two stories to fix, two investigators to look at them, and nobody to write a line of code. The
 * reviewer found nothing wrong because nothing it was given was wrong — every agent present was
 * well-formed. Absence is not a defect any per-agent review can see.
 *
 * The existing guard covers a NEIGHBOURING case: a correction cycle that removes agents and mints
 * no replacement. This is the same failure without the correction cycle — the mint simply never
 * drew an implementer, and every check downstream was satisfied until assignment tried to use one.
 *
 * The check belongs where the cause is visible. "No implementer exists" is decidable from the
 * roster and the stories the instant the mint returns, needs no model to adjudicate, and is exactly
 * the deterministic-over-persuasion rule: do not ask the mint more nicely, verify what it produced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

const story = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, status: 'pending', kind: 'defect', ...over,
});
const agent = (name: string, kind: string, codeline?: string) => ({ name, kind, codeline });

describe('a roster with no implementer was called sound', () => {
  it('the check is reachable', () => {
    expect(typeof spec.rosterImplementationGap,
      'nothing verifies the roster can implement the work it was minted for').toBe('function');
  });

  it('NAMES NO KIND — the requirement is derived from the registry', () => {
    // It used to read `a.kind !== 'investigator'`: engine code naming one of the schema's kinds
    // and inferring policy from it. Which artefacts are REQUIRED, and which seam produces each,
    // is already declared in invocation-profiles.json; add a kind tomorrow and this must still
    // be right without an edit here.
    const src = readFileSync(
      join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const i = src.indexOf('function rosterImplementationGap');
    const body = src.slice(i, src.indexOf('\nfunction ', i + 10));
    expect(body, "the check still names the kind 'investigator' in engine code")
      .not.toMatch(/['"]investigator['"]/);
    expect(body, "the check still names the kind 'implementer' in engine code")
      .not.toMatch(/['"]implementer['"]/);
    expect(body, 'the requirement is not derived from the registry').toMatch(/consumes|produces|required/);
  });

  it('THE LIVE CASE IS A GAP — two investigators, no implementer, two stories to fix', () => {
    const gap = spec.rosterImplementationGap({
      minted: [agent('transit-fare-engineer', 'investigator', 'mocka'),
        agent('transit-schedule-engineer', 'investigator', 'mockb')],
      projectRoles: [],
    }, [story('MOCK3-1'), story('MOCK3-2')]);

    expect(gap, 'a roster with nobody to write code was accepted').toBeTruthy();
    expect(gap, 'the operator is not told what is missing').toMatch(/implement/i);
    // Naming the investigators matters: the roster is not empty, which is why "sound" was
    // plausible. The reader needs to see what IS there to understand what is not.
    expect(gap).toMatch(/investigator/i);
  });

  it('a roster WITH an implementer is no gap', () => {
    expect(spec.rosterImplementationGap({
      minted: [agent('fare-logic-engineer', 'implementer'), agent('mocka-investigator', 'investigator', 'mocka')],
      projectRoles: ['fare-logic-engineer'],
    }, [story('MOCK3-1')]), 'a healthy roster was reported as broken').toBeFalsy();
  });

  it('an implementer registered in projectRoles alone still counts', () => {
    // The two records are written by different paths; requiring both would fail a valid roster.
    expect(spec.rosterImplementationGap(
      { minted: [], projectRoles: ['some-engineer'] }, [story('S-1')])).toBeFalsy();
  });

  it('NO STORIES TO IMPLEMENT IS NOT A GAP — this must not fire on an empty backlog', () => {
    // The guard exists to catch "work with nobody to do it", not to demand an implementer for a
    // run that has nothing to implement. Firing here would block a legitimate run.
    expect(spec.rosterImplementationGap({ minted: [], projectRoles: [] }, [])).toBeFalsy();
  });

  it('stories already complete do not demand an implementer', () => {
    expect(spec.rosterImplementationGap(
      { minted: [], projectRoles: [] },
      [story('S-1', { status: 'completed', completed: true })])).toBeFalsy();
  });

  it('survives missing or malformed input rather than throwing mid-mint', () => {
    // A crash here would replace a clear diagnosis with a stack trace at the worst moment.
    expect(() => spec.rosterImplementationGap(null, null)).not.toThrow();
    expect(() => spec.rosterImplementationGap({}, [story('S-1')])).not.toThrow();
  });
});
