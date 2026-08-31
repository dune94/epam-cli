/**
 * "NO DOCUMENTS WERE LINKED" AND "THE LINKED DOCUMENTS COULD NOT BE READ" ARE DIFFERENT ANSWERS.
 *
 * The ticket-links seam reads documents linked on a ticket and quotes them back, so the spec is
 * written against what the documentation actually says. When that call failed:
 *
 *     console.warn(`spec-mode: ticket-link review unavailable for ${story.id} ... — proceeding
 *                   without documentation evidence`);
 *     return [];
 *
 * and referencedDocsBlock([]) renders an EMPTY STRING — exactly what a ticket with no links
 * renders. The warning goes to the console; the agent writing the spec never learns of it, and
 * specifies as though the ticket carried no documentation at all.
 *
 * The caller knows better: `links` is in its hand, so it knows documents existed and produced
 * nothing. That is the one fact worth carrying into the prompt.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { referencedDocsBlock } = require(join(REPO, 'orchestrations/scripts/spec-mode-runner.js'));

describe('unreadable documentation is not the same as no documentation', () => {
  it('the renderer is exported, so this can be asserted at all', () => {
    expect(typeof referencedDocsBlock).toBe('function');
  });

  it('a ticket with no links renders nothing — unchanged', () => {
    expect(referencedDocsBlock([])).toBe('');
    expect(referencedDocsBlock(null as never)).toBe('');
  });

  it('relevant documents are quoted, as before', () => {
    const out = referencedDocsBlock([
      { relevant: true, url: 'https://example/doc', classification: 'spec',
        reason: 'defines the field', quotes: ['the field is case-insensitive'] },
    ]);
    expect(out).toContain('https://example/doc');
    expect(out).toContain('the field is case-insensitive');
  });

  it('documents that could not be read say so, and do not render as absence', () => {
    // The defect. This must NOT be an empty string, because an empty string tells the agent the
    // ticket carried no documentation.
    const out = referencedDocsBlock([
      { relevant: true, unreadable: true, url: '(2 documents linked on this ticket)',
        reason: 'the link agent timed out' },
    ]);
    expect(out.trim().length,
      'unreadable documentation rendered as nothing — indistinguishable from a ticket with no '
      + 'links at all').toBeGreaterThan(0);
    expect(out, 'the block does not say the documents could not be read')
      .toMatch(/could not be read|unreadable/i);
    expect(out, 'the agent is not told what to do about it — silence about a failed lookup invites '
      + 'it to specify as though nothing was linked').toMatch(/not.*absence|do not treat/i);
  });

  it('and the failure path returns that marker rather than an empty list', () => {
    // The receiver: a renderer that handles the marker correctly changes nothing if the caller
    // still returns [].
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const src = require('node:fs').readFileSync(
      join(REPO, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    const i = src.indexOf('ticket-link review unavailable');
    expect(i, 'the failure path is gone — the shape has changed').toBeGreaterThan(-1);
    // Bounded to the catch's own return, not a fixed character window — the first version took
    // 600 characters, ran past the function, and matched an unrelated `return [];` further down.
    const arm = src.slice(i, src.indexOf('\n      }', i));
    expect(arm, 'the failure path returns unconditionally, so it cannot distinguish a ticket with '
      + 'links from one without').toMatch(/return links\.length \?/);
    expect(arm, 'the marker it returns does not carry the unreadable flag')
      .toMatch(/unreadable: true/);
  });
});
