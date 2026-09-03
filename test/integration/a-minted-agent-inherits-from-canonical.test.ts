/**
 * RETEST OF 731b682 / fcd36b2 — a fix and its revert, which net to zero in the tree.
 *
 * 9ce0277 merged the minted agents BEFORE the contract check, and run 7 died on the check itself:
 *
 *     [roster] canonical does not satisfy the roster contract:
 *     fare-rules-engineer: ancestor 'fare-rules-engineer' is not in canonical
 *
 * 731b682 moved the merge to after the check; fcd36b2 reverted it. So the shipped behaviour today
 * is the ORIGINAL one, and the question this retest has to answer is not "did the fix land" but
 * "is what ships correct".
 *
 * The rule under test: every entry's ancestor must name an entry in canonical. That is how an
 * agent inherits a ladder, a tool grant and an output contract — an ancestor naming nothing means
 * an agent inherits nothing, and a minted agent that names ITSELF as ancestor inherits from a
 * thing that does not exist yet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const roster = require('../../orchestrations/scripts/lib/project-roster.js');

// EVERY ENTRY CARRIES A KIND. checkEntry validates that before it looks at ancestry, so a
// fixture without one fails on the kind and never reaches the rule under test — which is how a
// test can 'fail correctly' while proving nothing about what it claims to check.

// The real canonical roster, not a shape I invent: its keys are the ancestors anything may claim.
const CANONICAL = JSON.parse(readFileSync(
  join(__dirname, '../../orchestrations/agents/profiles.canonical.json'), 'utf8'));
const A_REAL_ANCESTOR = Object.keys(CANONICAL)[0];

describe('a minted agent inherits from canonical', () => {
  it('the canonical roster has entries to inherit from — otherwise nothing is under test', () => {
    expect(Object.keys(CANONICAL).length).toBeGreaterThan(10);
    expect(A_REAL_ANCESTOR).toBeTruthy();
  });

  it('accepts an entry whose ancestor names a real canonical agent, with a real digest', () => {
    // THE FIELD IS derivedFromSha256 — I wrote provenanceDigest first, from the error message
    // rather than from the code, and the test failed for a reason that had nothing to do with
    // what it claims to check.
    //
    // THE DIGEST IS PART OF THE CONTRACT, and it is computed here with the library's own
    // personaDigest rather than invented — a hand-written digest would only ever prove that a
    // wrong value is rejected, which is the next test's job, not this one's.
    const persona = 'A specialised persona. '.repeat(6);
    const ok = roster.checkEntry(
      'some-project-engineer',
      {
        ancestor: A_REAL_ANCESTOR,
        kind: 'implementer',
        persona,
        derivedFromSha256: roster.personaDigest(CANONICAL[A_REAL_ANCESTOR]),
      },
      CANONICAL,
    );
    expect(ok && ok.ok, `a legitimate ancestor was refused: ${ok && ok.reason}`).toBe(true);
  });

  it('REFUSES an entry whose digest does not match the ancestor it claims', () => {
    // An agent may not claim descent from a brief it was not derived from: the digest is what
    // makes "inherits a ladder, a tool grant and an output contract" mean something.
    const bad = roster.checkEntry(
      'some-project-engineer',
      {
        ancestor: A_REAL_ANCESTOR,
        kind: 'implementer',
        persona: 'A specialised persona. '.repeat(6),
        derivedFromSha256: roster.personaDigest('a brief this agent never derived from'),
      },
      CANONICAL,
    );
    expect(bad && bad.ok, 'descent from an unrelated brief was accepted').toBe(false);
    expect(String(bad && bad.reason)).toMatch(/digest/i);
  });

  it('REFUSES an ancestor that names nothing in canonical', () => {
    // The exact failure from run 7: the entry claimed itself as ancestor, so there was nothing to
    // inherit a ladder, a tool grant or an output contract from.
    const bad = roster.checkEntry(
      'fare-rules-engineer',
      { ancestor: 'fare-rules-engineer', kind: 'implementer',
        persona: 'A specialised persona. '.repeat(6) },
      CANONICAL,
    );
    expect(bad && bad.ok, 'an agent may inherit from something that does not exist').toBe(false);
    expect(String(bad && bad.reason)).toMatch(/not in canonical/i);
  });

  it('refuses an entry with no ancestor at all', () => {
    const bad = roster.checkEntry(
      'orphan-engineer',
      { kind: 'implementer', persona: 'A specialised persona. '.repeat(6) },
      CANONICAL,
    );
    expect(bad && bad.ok, 'an agent with no ancestor inherits nothing and is still accepted')
      .toBe(false);
  });
});
