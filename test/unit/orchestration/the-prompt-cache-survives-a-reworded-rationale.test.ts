/**
 * THE PROMPT CACHE MUST SURVIVE A REWORDED RATIONALE.
 *
 * Operator design, 2026-09-04: "profiles and prompts should be run once and saved for a codeline.
 * subsequent runs against the same code line should not be regenerated. only the first time."
 *
 * Measured on the real cache afterwards: 39 entries, **0 hits**. Of those entries, 28 carry
 * `usesRoles: true`, and their hit condition is
 *
 *     _hit.base === _base && (!_hit.usesRoles || _hit.roles === rolesDigest)
 *
 * where `rolesDigest = sha(mintedRoles)` and mintedRoles is the mint's own prose:
 *
 *     - checkout-form-engineer [implementer] — owns the checkout form and its validation
 *       ^ identity, stable                     ^ MODEL-WRITTEN RATIONALE, reworded every run
 *
 * So two runs that mint exactly the same roles produce different digests, and 28 of 39 prompts
 * are regenerated every time — at model prices — for a difference no prompt can observe.
 *
 * WHAT THE KEY IS FOR tells you what belongs in it. usesRoles() decides a prompt depends on the
 * roster by extracting role NAMES and asking whether the generated prompt mentions any of them.
 * The names are the only thing a prompt can embed, so the names — with their kinds, because a
 * kind changes what an agent may do — are the only thing that can invalidate it. The rationale is
 * commentary the generator reads and never quotes.
 *
 * DERIVED, NOT LISTED: no role name, count or ordering appears here or in the implementation. The
 * identity set is read out of whatever the mint produced.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const MOD = join(__dirname, '../../../orchestrations/scripts/lib/project-prompt-builder.js');
const { rolesIdentity } = require(MOD);

describe('what identifies a roster, for caching', () => {
  it('the deriver is exported', () => {
    expect(typeof rolesIdentity, 'rolesIdentity is not exported from project-prompt-builder.js')
      .toBe('function');
  });

  const run1 = [
    '- checkout-form-engineer [implementer] — owns the checkout form and its validation',
    '- fare-rules-engineer [implementer] — owns fare calculation',
  ].join('\n');

  // The SAME roles, described differently: this is what a second mint of one codeline produces.
  const run2 = [
    '- checkout-form-engineer [implementer] — responsible for the checkout form, including validation',
    '- fare-rules-engineer [implementer] — handles the fare rules and their calculation',
  ].join('\n');

  it('a reworded rationale is the SAME roster', () => {
    expect(rolesIdentity(run1), [
      'the cache key changes when the mint merely rephrases itself, so 28 of 39 prompts are',
      'regenerated at model prices every run for a difference no prompt can observe.',
    ].join('\n')).toBe(rolesIdentity(run2));
  });

  it('an ADDED role is a different roster — the key must still invalidate', () => {
    const added = `${run1}\n- payments-engineer [implementer] — owns payments`;
    expect(rolesIdentity(added), 'a new agent left the cache valid; a prompt could name it')
      .not.toBe(rolesIdentity(run1));
  });

  it('a REMOVED role is a different roster', () => {
    const removed = '- checkout-form-engineer [implementer] — owns the checkout form';
    expect(rolesIdentity(removed)).not.toBe(rolesIdentity(run1));
  });

  it('a CHANGED KIND is a different roster — it changes what the agent may do', () => {
    const asInvestigator = run1.replace('[implementer]', '[investigator]');
    expect(rolesIdentity(asInvestigator),
      'an implementer became an investigator and the cache stayed valid — the kind decides whether '
      + 'that agent may author code at all')
      .not.toBe(rolesIdentity(run1));
  });

  it('ORDER does not matter — the mint does not promise one', () => {
    const reordered = run1.split('\n').reverse().join('\n');
    expect(rolesIdentity(reordered)).toBe(rolesIdentity(run1));
  });

  it('no roles at all is stable, and distinct from having some', () => {
    expect(rolesIdentity('(none minted this run)')).toBe(rolesIdentity(''));
    expect(rolesIdentity('')).not.toBe(rolesIdentity(run1));
  });
});
