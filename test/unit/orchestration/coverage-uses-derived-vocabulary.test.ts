/**
 * THE COVERAGE CHECK MUST NOT CARRY ITS OWN WORD LIST.
 *
 * checkFixSiteCoverage decides whether each verification criterion is addressed by some fix
 * site, by comparing their terms. To do that it filtered out "unimportant" words using a
 * hardcoded English stopword list baked into the engine:
 *
 *     const STOPWORDS = new Set(['the','a','an','and','or','to','of','in','on', …]);
 *
 * That is the hardcoding rule's named example. It also does not work: the list is English, the
 * terms it keeps are whatever survives, and a criterion phrased in this project's own domain
 * language is scored against fix-site prose by raw word overlap.
 *
 * This pipeline already derives word lists with an agent, in context, per ticket — codeline
 * discovery reports "34 term(s) carry no selection signal, 13 protected", and the guard
 * vocabulary agent returns {blacklist, whitelist} at each guard seam. Coverage must take that
 * derived vocabulary as INPUT rather than inventing its own.
 *
 * And when no vocabulary is available it must say so, not fall back to a guess: a coverage
 * verdict computed from a made-up word list is worse than no verdict, because something
 * downstream will trust it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

const SITES = [
  { file: 'src/services/client.ts', function: 'createClient',
    reason: 'where the client is configured', fix: 'enable the draft option' },
];
const CRITERIA = [
  'an editor sees unpublished content without reloading the page',
  'the client is configured to request draft content',
];
/** What the vocabulary agent returns: terms that carry no selection signal for THIS ticket. */
const VOCAB = {
  blacklist: [
    { term: 'the', reason: 'no selection signal' },
    { term: 'content', reason: 'appears in every finding about this integration' },
    { term: 'without', reason: 'no selection signal' },
  ],
  whitelist: [{ term: 'draft', reason: 'the observable surface' }],
};

describe('the engine carries no word list of its own', () => {
  it('no hardcoded stopword list remains in the source', () => {
    expect(
      SRC,
      'a baked English word list is the hardcoding rule\'s named example, and it decides which ' +
      'criteria count as covered',
    ).not.toMatch(/STOPWORDS\s*=\s*new Set\(/);
  });

  it('coverage accepts a derived vocabulary as input', () => {
    expect(spec.checkFixSiteCoverage.length,
      'the function still decides noise for itself').toBeGreaterThanOrEqual(3);
  });
});

describe('it uses the vocabulary it is given', () => {
  it('a criterion whose only overlap is a blacklisted term is NOT counted as covered', () => {
    // "content" is in every finding about this integration — matching on it would mark any
    // criterion covered by any site.
    const r = spec.checkFixSiteCoverage(SITES, ['unpublished content appears'], VOCAB);
    expect(r.uncoveredVerificationCriteria).toEqual(['unpublished content appears']);
  });

  it('a criterion sharing a real term IS counted as covered', () => {
    const r = spec.checkFixSiteCoverage(SITES, ['the client is configured for draft'], VOCAB);
    expect(r.uncoveredVerificationCriteria).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('it reports every uncovered criterion, not just the first', () => {
    const r = spec.checkFixSiteCoverage(SITES, [
      'an editor sees changes without reloading',
      'errors are surfaced when the connection drops',
    ], VOCAB);
    expect(r.uncoveredVerificationCriteria.length).toBe(2);
  });
});

describe('with no vocabulary it refuses to guess', () => {
  it('returns an explicit unknown rather than a computed verdict', () => {
    const r = spec.checkFixSiteCoverage(SITES, CRITERIA, null);
    expect(
      r.complete,
      'a verdict computed from a word list nobody derived will be trusted downstream',
    ).toBeNull();
    expect(r.reason).toMatch(/vocabular/i);
  });

  it('an empty vocabulary is also unknown, not "everything is noise"', () => {
    const r = spec.checkFixSiteCoverage(SITES, CRITERIA, { blacklist: [], whitelist: [] });
    expect(r.complete).toBeNull();
  });
});
