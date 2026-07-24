/**
 * AC immutability — speckit bypass (found live 2026-07-24, AMSD-1820 run).
 *
 * The immutability guard (preserveDefectAcceptanceCriteria) was applied ONLY in
 * runSpecAgent's `agent==='openspec'` branch. But speckit's prompt explicitly asks
 * it for "the FULL merged acceptanceCriteria list", and that payload reached
 * applySpecChanges with NO guard — so a brownfield ticket that arrived with ZERO
 * acceptance criteria (immutable ticket intent) came out of the spec pass with 9
 * fabricated Given/When/Then ACs, several mechanism-flavored. That is exactly the
 * AC-elaboration drift the whole AC/VC/TC design exists to eliminate, leaking one
 * agent downstream of the openspec guard.
 *
 * Fix: preserveDefectAcceptanceCriteria is now a UNIVERSAL backstop at the top of
 * applySpecChanges — the single merge choke point every agent + retry path flows
 * through. Brownfield ACs are the immutable ticket intent for EVERY agent; greenfield
 * is untouched (speckit still merges/refines ACs there).
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { applySpecChanges } = spec;

// Minimal args applySpecChanges needs; newStories/prd only matter for splits.
function apply(story: any, payload: any, env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const prd = { stories: [story], implementationOrder: { core: [story.id] } };
    return applySpecChanges(story, payload, [], prd, 'core', 'run-test', null);
  } finally {
    // restore env exactly (delete keys we added)
    for (const k of Object.keys(env)) {
      if (!(k in saved)) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  }
}

// The real live shape: a 0-AC brownfield defect + a speckit payload that "merged"
// nine fabricated Given/When/Then acceptance criteria.
const NINE_FABRICATED_ACS = [
  'Given a one-way trip with a promo code, When the email is generated, Then the discount displays.',
  'Given a return trip with a promo code, When the email is generated, Then the return-leg discount displays.',
  'Given both legs discounted, When the email is generated, Then the total across both legs equals the expected total.',
  'Given only the outbound discounted, When the email is generated, Then the return leg shows zero.',
  'Given no promo, When the email is generated, Then no discount is displayed.',
  'Given a zero discount, When the email is generated, Then it displays as zero.',
  'Given the modification mapping pipeline runs, Then the discount is preserved through it.',
  'Given the from/to stations are swapped, Then the discount stays with the return leg.',
  'Given a null discount field, Then the system handles it gracefully.',
];

describe('applySpecChanges — brownfield ACs are immutable for the SPECKIT payload too', () => {
  it('a 0-AC brownfield ticket stays 0 ACs even when speckit emits 9 merged ACs (the live bug)', () => {
    const story: any = { id: 'AMSD-1820', title: 'promo not shown for return trip', acceptanceCriteria: [] };
    const speckitPayload: any = { agent: 'speckit', acceptanceCriteria: NINE_FABRICATED_ACS };

    const res = apply(story, speckitPayload, { EPAM_BROWNFIELD: '1' });

    expect(story.acceptanceCriteria).toEqual([]);     // immutable ticket intent held
    expect(res.acceptanceChanged).toBe(false);        // nothing was written
    // the mechanism-flavored fabrication must not have leaked in
    expect(JSON.stringify(story.acceptanceCriteria)).not.toContain('modification mapping');
  });

  it('a brownfield ticket that HAS original ACs keeps exactly those, not speckit\'s rewrite', () => {
    const original = ['The promo discount is shown for the return trip in the email.'];
    const story: any = { id: 'AMSD-1820', title: 't', acceptanceCriteria: [...original] };
    const speckitPayload: any = { agent: 'speckit', acceptanceCriteria: NINE_FABRICATED_ACS };

    apply(story, speckitPayload, { EPAM_BROWNFIELD: '1' });

    expect(story.acceptanceCriteria).toEqual(original);
  });

  it('description/title/technicalNotes from speckit STILL merge (only ACs are frozen)', () => {
    const story: any = { id: 'X', title: 'old', description: 'old desc', acceptanceCriteria: [] };
    const payload: any = { agent: 'speckit', acceptanceCriteria: NINE_FABRICATED_ACS, description: 'new desc', title: 'new title' };

    apply(story, payload, { EPAM_BROWNFIELD: '1' });

    expect(story.acceptanceCriteria).toEqual([]);   // frozen
    expect(story.description).toBe('new desc');      // non-AC fields flow through
    expect(story.title).toBe('new title');
  });
});

describe('applySpecChanges — greenfield is unchanged (speckit still merges ACs)', () => {
  it('greenfield: a speckit merged AC list IS written to the story', () => {
    const story: any = { id: 'G', title: 't', acceptanceCriteria: ['seed AC'] };
    const payload: any = { agent: 'speckit', acceptanceCriteria: ['refined AC 1', 'refined AC 2'] };

    const res = apply(story, payload, { EPAM_BROWNFIELD: undefined }); // not brownfield

    expect(story.acceptanceCriteria).toEqual(['refined AC 1', 'refined AC 2']);
    expect(res.acceptanceChanged).toBe(true);
  });
});
