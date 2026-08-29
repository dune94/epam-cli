/**
 * THE STAND-IN MUST PASS THE GATE THE REAL AGENT PASSES.
 *
 * The free rehearsal exists so the mint can be exercised without paying. That only holds if the
 * mock's own answer satisfies the mint's contract — and four times running it did not, each one
 * reading in the log exactly like a pipeline defect:
 *
 *   1. `kind` filled with prose, so the mint refused "unrecognised kind"
 *   2. `name` filled with prose containing spaces — "not a plain kebab-case identifier"
 *   3. `rationale` 19 characters against a declared minimum of 24 — "says nothing"
 *   4. the name suffixed after the seam, routing nowhere — "resolves to no seam"
 *
 * Each cost a rehearsal to find. All four are one assertion: put the stand-in through
 * isUsableProposal — the mint's own gate, not a copy of it — and the harness can never again
 * fail the run it was built to make free.
 */
import { describe, it, expect } from 'vitest';

const mock = require('../../../orchestrations/scripts/mock-expectations.js');
const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

describe('the mock satisfies the gate it answers', () => {
  it('the mint stand-in passes the mint\'s own usability gate', () => {
    const standIn = mock.contractStandIn('agent-mint');
    expect(standIn, 'the harness must produce a mint answer at all').toBeTruthy();

    const proposals = Array.isArray(standIn) ? standIn
      : (standIn.agents || standIn.projectAgents || [standIn]);
    expect(proposals.length, 'a stand-in proposing nothing proves nothing').toBeGreaterThan(0);

    for (const p of proposals) {
      // isUsableProposal returns a REASON when it refuses, and null when it accepts.
      expect(roster.isUsableProposal(p), `the mint refused its own stand-in: ${p && p.name}`)
        .toBeFalsy();
    }
  });

  it('a role-valued field is recognised however the contract words it', () => {
    // The property that broke this was worded in the plural — the one property the function
    // exists to recognise was the one its regex missed.
    expect(mock.expectsARole({ description: 'MUST be one of the offered roles, verbatim.' })).toBe(true);
    expect(mock.expectsARole({ description: 'The role that owns this story.' })).toBe(true);
    expect(mock.expectsARole({ description: 'One sentence: why this owns this story.' })).toBe(false);
  });

  it('the name the mint registers is the name the assigner offers', () => {
    // Two stand-ins, one registry: the assigner cannot offer a role the mint never minted.
    const minted = mock.standInRoleName('implementer');
    expect(minted, 'no implementer name routes — the registry declares one').toBeTruthy();
    expect(minted).toMatch(roster.ROLE_NAME_RE);
    expect(roster.isUsableProposal({
      name: minted, kind: 'implementer', systemPrompt: 'x', rationale: 'y'.repeat(40),
      codeline: '*',
    }), `the minted implementer name is not usable: ${minted}`).toBeFalsy();
  });
});
