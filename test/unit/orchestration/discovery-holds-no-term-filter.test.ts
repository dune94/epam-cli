/**
 * DISCOVERY FILTERS NO TERMS AT ALL — and no longer pays an agent to decide which to drop.
 *
 * THE HISTORY THIS REPLACES. scoreRepos filtered the ticket's words through a list written into
 * the generic pipeline — English filler, fixed, wrong for a ticket in any other language, and
 * deciding which client repository gets modified. Removing the list was correct and incomplete:
 * a second filter survived four lines above it (`w.length >= 4`), and the replacement for the
 * list was an LLM call — discovery-vocabulary-agent — whose entire job was to produce a better
 * blacklist for a filter that should not have existed.
 *
 * The length filter discarded `UP`, `MX` and `GO`: the identifiers that name the product, and the
 * only tokens separating two sibling repositories in one estate. It kept the generic prose.
 *
 * THE WHOLE APPARATUS IS GONE. The ticket reaches the agent verbatim, and the agent has tools to
 * search the estate. Measured on the live estate, the filtering existed to save ~4,800 tokens of
 * prompt and cost a full extra agent call to do it — a net loss before counting the wrong answers.
 *
 * These tests hold the two properties that outlive the mechanism: no filtering, and no second
 * agent call to support filtering.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE = join(__dirname, '../../../orchestrations/scripts/lib/codeline-discovery.js');
const SOURCE = readFileSync(MODULE, 'utf8');
const CODE = SOURCE.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('the ticket reaches the agent as written', () => {
  it('no term list, in any language', () => {
    // The shape of the original defect: an array of words used to filter the ticket.
    expect(CODE).not.toMatch(/\[\s*'[a-z]{3,}'\s*,\s*'[a-z]{3,}'\s*,/);
  });

  it('no length cutoff deciding which words count', () => {
    expect(CODE).not.toMatch(/length\s*>=\s*\d/);
  });

  it('no vocabulary agent — nothing filters, so nothing needs a filter derived', () => {
    expect(CODE).not.toMatch(/deriveDiscoveryVocabulary|deriveVocabularyOrAbort/);
    expect(CODE).not.toMatch(/applyVocabulary/);
  });

  it('and the words that name a product survive into the prompt', () => {
    // The live case: a two-character product identifier is the whole discriminator.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { buildDiscoveryPrompt } = require(MODULE);
    const prompt = buildDiscoveryPrompt(
      [{ jiraKey: 'X-1', title: '[UP] a change', components: ['UP'], labels: [], description: 'go to MX' }],
      [{ name: 'a', path: '/a' }],
    );
    expect(prompt).toContain('[UP] a change');
    expect(prompt).toContain('MX');
  });
});
