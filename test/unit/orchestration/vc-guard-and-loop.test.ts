/**
 * VC guard + autonomous regenerate loop.
 *
 * A VC must describe WHAT a tester observes, never HOW to implement it. On a flag the
 * pipeline resolves autonomously (no human): regenerate via openspec (ladder-escalating
 * per cycle) → re-check → and if it still cannot converge, a conservative mechanism-free
 * fallback.
 *
 * WHY THIS FILE WAS REWRITTEN (2026-08-06)
 * ----------------------------------------
 * It was the THIRD copy of one incident. The guard's patterns were reverse-engineered from
 * five sentences in a fare-discount bug; the same five sentences were repeated in the rule
 * prose; and this file fed those same five sentences back as its fixture:
 *
 *     it('flags the exact domain-mechanism phrasing that misdirected the fix', ...)
 *
 * "the exact phrasing" — a tautology. It asserted the regexes matched the text they were
 * derived from, so it passed permanently and carried no information about anything else.
 * That is what made the guard's uselessness invisible: two VCs plainly prescribing
 * mechanism ("the SDK is initialized and its onEntryChange callback is registered") sailed
 * through while the run log reported the guard clean.
 *
 * The guard now holds NO content. What counts as a violation is derived per story by the
 * guard-vocabulary agent and passed in. So these tests supply vocabularies explicitly, and
 * deliberately use domains this codebase was never built around — a guard that can only be
 * tested with its own authors' examples is not a guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { findVcMechanism, safeFallbackVc, enforceVerificationCriteria } = spec;

const STORY = {
  id: 'T',
  title: 'shipment status not shown after carrier update',
  acceptanceCriteria: ['the tracking page reflects the latest carrier status'],
};

/** A vocabulary from a domain nothing here was built around — the whole point. */
const VOCAB = {
  blacklist: [
    { term: 'webhook handler', reason: 'names the internal component', kind: 'implementation_noun' },
    { term: 'is polled', reason: 'describes how the value is obtained', kind: 'construction_verb' },
    { term: 'status_cache table', reason: 'an internal structure feeding the surface', kind: 'internal_structure' },
  ],
  whitelist: [{ term: 'tracking page' }, { term: 'carrier status' }],
};

/** Arms the guard the way the pipeline does, without calling a model. */
const armed = (vocab: any = VOCAB) => ({ deriveVocabulary: async () => vocab });

describe('findVcMechanism — a pure applier, holding no content', () => {
  it('flags a violation described by the SUPPLIED vocabulary', () => {
    const flagged = findVcMechanism(
      ['The webhook handler writes the new state before the page renders.'], 'T', VOCAB);
    expect(flagged.length).toBe(1);
    expect(flagged[0].reason).toMatch(/internal component/);
  });

  it('leaves the observable surface alone', () => {
    expect(findVcMechanism(
      ['The tracking page shows the latest carrier status within one minute.'], 'T', VOCAB)).toEqual([]);
  });

  it('the SAME criterion is clean under a vocabulary that does not name it — behaviour comes from the vocabulary, not the code', () => {
    expect(findVcMechanism(
      ['The webhook handler writes the new state.'], 'T',
      { blacklist: [{ term: 'invoice total', reason: 'x' }], whitelist: [] })).toEqual([]);
  });

  it('flags nothing when handed an empty vocabulary — it cannot invent a rule', () => {
    expect(findVcMechanism(['anything at all'], 'T', { blacklist: [], whitelist: [] })).toEqual([]);
  });
});

describe('safeFallbackVc — conservative, and clean under any vocabulary', () => {
  it('is derived from the ticket and is not itself mechanism', () => {
    const fb = safeFallbackVc(STORY);
    expect(fb.length).toBeGreaterThan(0);
    expect(findVcMechanism(fb, null, VOCAB)).toEqual([]);
    expect(fb[0]).toMatch(/observed to be correct/);
  });
});

describe('ARMED OR ABORT — an unarmed guard must never report clean', () => {
  it('aborts when the vocabulary agent yields nothing', async () => {
    await expect(enforceVerificationCriteria(STORY, ['anything'], {
      deriveVocabulary: async () => null,
    })).rejects.toThrow(/could not be armed/i);
  });

  it('aborts when the agent throws', async () => {
    await expect(enforceVerificationCriteria(STORY, ['anything'], {
      deriveVocabulary: async () => { throw new Error('ladder exhausted'); },
    })).rejects.toThrow(/could not be armed/i);
  });

  it('aborts on an empty blacklist — "derived nothing" is not "nothing to flag"', async () => {
    await expect(enforceVerificationCriteria(STORY, ['anything'], {
      deriveVocabulary: async () => ({ blacklist: [], whitelist: [] }),
    })).rejects.toThrow(/could not be armed/i);
  });

  it('persists the vocabulary so a re-run applies the identical checks', async () => {
    const story: any = { ...STORY };
    await enforceVerificationCriteria(story, ['The tracking page shows the latest carrier status.'], armed());
    expect(story.specification.guardVocabulary.blacklist.length).toBe(VOCAB.blacklist.length);
  });
});

describe('enforceVerificationCriteria — autonomous loop (no human, never halts)', () => {
  it('clean VC → persisted as-is (source: clean), no regenerate', async () => {
    const r = await enforceVerificationCriteria(
      STORY, ['The tracking page shows the latest carrier status.'], armed());
    expect(r.source).toBe('clean');
  });

  it('mechanism VC with no regenerator → conservative fallback (never a mechanism VC)', async () => {
    const r = await enforceVerificationCriteria(
      STORY, ['The status is polled from the carrier every minute.'], armed());
    expect(r.source).toBe('fallback');
    expect(findVcMechanism(r.vc, null, VOCAB)).toEqual([]);
  });

  it('mechanism VC + a regenerator that fixes it → regenerated (clean)', async () => {
    const r = await enforceVerificationCriteria(STORY, ['The webhook handler updates it.'], {
      ...armed(),
      regenerateVc: async () => ['The tracking page shows the latest carrier status.'],
    });
    expect(r.source).toBe('regenerated');
    expect(findVcMechanism(r.vc, null, VOCAB)).toEqual([]);
  });

  it('speckit flags an otherwise clean VC → regenerate loop resolves it', async () => {
    let cycleSeen = 0;
    const r = await enforceVerificationCriteria(STORY, ['The thing works.'], {
      ...armed(),
      reviewVc: async (_vc: string[], c: number) => { cycleSeen = c; return c === 1 ? ['too vague, not testable'] : []; },
      regenerateVc: async () => ['The tracking page shows the latest carrier status.'],
    });
    expect(r.source).toBe('regenerated');
    expect(cycleSeen).toBeGreaterThanOrEqual(1);
  });

  it('a regenerator that keeps producing mechanism → still ends in a safe fallback (bounded)', async () => {
    const r = await enforceVerificationCriteria(STORY, ['The status is polled.'], {
      ...armed(),
      regenerateVc: async () => ['The status is polled again.'], // never clean
      maxCycles: 2,
    });
    expect(r.source).toBe('fallback');
    expect(findVcMechanism(r.vc, null, VOCAB)).toEqual([]);
  });
});

describe('no hardcoded vocabulary survives in the guard', () => {
  const SRC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('the pattern lists are gone, not merely narrowed', () => {
    expect(code).not.toMatch(/VC_MECHANISM_PATTERNS|PRESCRIPTIVE_AC_PATTERNS/);
  });

  it('no client, vendor or industry noun remains in guard code', () => {
    expect(code).not.toMatch(/metrolinx|gotransit|upexpress|contentstack|mozio/i);
  });

  it('the rule states a principle and enumerates no examples from any past incident', () => {
    const i = code.indexOf('const VC_OBSERVABILITY_RULES');
    const rule = code.slice(i, code.indexOf('`;', i));
    expect(rule, 'the rule carries remembered example phrasings again').not.toMatch(
      /"split"|"halve"|×0\.5|per segment|for each line item|outbound/i);
  });
});

describe('VC enforcement is wired into the brownfield merge block', () => {
  const src = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('calls enforceVerificationCriteria with regenerate + review callbacks and persists resolution', () => {
    expect(src).toMatch(/await enforceVerificationCriteria\(story, rawVc/);
    expect(src).toMatch(/regenerateVc: \(flags, nextCycle\) => regenerateVcViaOpenspec/);
    expect(src).toMatch(/reviewVc: \(vc, cycle\) => reviewVcViaSpeckit/);
    expect(src).toMatch(/story\.vcResolution = enforced\.source/);
  });

  it('the guard is armed from the VCs, the manifest AND the detective evidence', () => {
    expect(src).toMatch(/deriveVocabulary: \(vcToCheck\) => deriveGuardVocabulary/);
    expect(src).toMatch(/manifestFiles: \(story && story\.technicalNotes/);
    expect(src).toMatch(/findings: detectiveFindings/);
  });
});
