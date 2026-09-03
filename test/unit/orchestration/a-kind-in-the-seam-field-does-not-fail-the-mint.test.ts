/**
 * THE RESOLVER ALREADY KNEW. A ROSTER ENTRY NAMING ITS KIND MUST NOT KILL THE RUN.
 *
 * Live 2026-08-31, metrolinx AMSD-1919: the mint proposed two agents, the roster review passed
 * them as sound, and provisioning refused them —
 *
 *     [roster] attempt 1/3 REFUSED: checkout-form-engineer: seam 'implementer' is not declared
 *
 * The model had written `seam: "implementer"` — which is a KIND, not a seam. And the registry says
 * so itself: the `(^|-)engineer$` pattern carries `kind: "implementer"` and resolves to
 * `story-writer`. So the resolver had the right answer the whole time; the run died over which
 * FIELD the word sat in.
 *
 * Failing closed is right when an agent resolves to NOTHING — it would run unconfigured. It is
 * wrong when the name resolves perfectly and only a redundant field is mistaken.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const roster = require(join(REPO, 'orchestrations/scripts/lib/project-roster.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { resolveSeam } = require(join(REPO, 'orchestrations/scripts/lib/seam-invocation.js'));

const persona = 'You implement the story in the codeline you are given.';
const entryFor = (seam?: string) => ({
  persona, kind: 'implementer', ancestor: 'checkout-form-engineer',
  derivedFromSha256: roster.personaDigest(persona),
  ...(seam === undefined ? {} : { seam }),
});

describe('a kind in the seam field does not fail the mint', () => {
  it('the premise holds: the name resolves on its own', () => {
    expect(resolveSeam('checkout-form-engineer', REGISTRY, { ignoreXref: true })).toBe('story-writer');
  });

  it('and the kind it named is one the registry itself declares', () => {
    expect(roster.agentKinds(), 'implementer is not a declared kind — the shape has changed')
      .toContain('implementer');
  });

  it('an entry naming its KIND in the seam field is accepted, not refused', () => {
    const v = roster.checkEntry('checkout-form-engineer', entryFor('implementer'),
      { 'checkout-form-engineer': persona });
    expect(v.ok, `the mint still dies over a redundant field: ${v.reason}`).toBe(true);
  });

  it('but a seam that is neither declared nor a kind is still refused', () => {
    // The negative half. This must not become "accept anything in the seam field".
    const v = roster.checkEntry('checkout-form-engineer', entryFor('not-a-real-seam'),
      { 'checkout-form-engineer': persona });
    expect(v.ok, 'an invented seam name was accepted').toBe(false);
    expect(v.reason).toMatch(/not declared/);
  });

  it('and an entry that names a real seam is still accepted', () => {
    const v = roster.checkEntry('checkout-form-engineer', entryFor('story-writer'),
      { 'checkout-form-engineer': persona });
    expect(v.ok, v.reason).toBe(true);
  });
});
