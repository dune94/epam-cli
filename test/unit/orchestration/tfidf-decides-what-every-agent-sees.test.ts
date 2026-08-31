/**
 * THE RETRIEVAL SCORER — it decides what context every agent is shown.
 *
 * Every brownfield agent is given the top-scoring chunks of the codebase and knowledge base for its
 * story. If the scorer ranks badly the agent is not told; it simply works from worse context and
 * produces a worse answer that looks exactly like a good one. There is no error path to catch here,
 * which is precisely why it needs assertions.
 *
 * Note on the tokenizer: this project's tickets are English-only by operator decision, so a
 * latin-only tokenizer is the stated contract rather than a defect.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { tokenize, computeTF, buildIDF, scoreDoc, extractChunk } = require(join(S, 'lib/tfidf.js'));

describe('tokenize keeps the words that carry meaning', () => {
  it('lowercases and splits on the separators identifiers really use', () => {
    expect(tokenize('ChargeCard payment_service order-total path/to/file.ts'))
      .toEqual(expect.arrayContaining(['chargecard', 'payment', 'service', 'order', 'total']));
  });

  it('STRIPS fenced code, because a code block is not what the query is about', () => {
    const t = tokenize('retry policy\n```\nunrelatedtoken unrelatedtoken\n```\nmore policy');
    expect(t, 'a fenced code block leaked into the terms').not.toContain('unrelatedtoken');
    expect(t).toContain('policy');
  });

  it('strips inline code too', () => {
    expect(tokenize('use `unrelatedinline` here')).not.toContain('unrelatedinline');
  });

  it('keeps the TEXT of a markdown link and discards its target', () => {
    const t = tokenize('see [payment retries](https://example.com/some/url/path)');
    expect(t, 'the link text was discarded').toContain('payment');
    expect(t, 'the URL leaked in as terms').not.toContain('example');
  });

  it('drops very short tokens and stopwords, which match everything and mean nothing', () => {
    const t = tokenize('the a an of to payments');
    expect(t, 'a stopword survived and will match every document').toEqual(['payments']);
  });

  it('an empty or punctuation-only string yields no terms rather than throwing', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! ... ???')).toEqual([]);
  });
});

describe('term frequency is a proportion, not a count', () => {
  it('scales by document length, so a long document does not win by being long', () => {
    const short = computeTF(tokenize('payments payments'));
    const long = computeTF(tokenize(`payments payments ${'filler '.repeat(50)}`));
    expect(short.payments, 'a short document did not score higher on the same term')
      .toBeGreaterThan(long.payments);
  });

  it('an empty document does not divide by zero', () => {
    expect(() => computeTF([])).not.toThrow();
    expect(computeTF([])).toEqual({});
  });
});

describe('inverse document frequency demotes what every document says', () => {
  const docs = [
    { content: 'payments retry logic' },
    { content: 'payments dashboard view' },
    { content: 'payments export csv' },
    { content: 'weather forecast service' },
  ];

  it('a term in EVERY document carries less weight than a rare one', () => {
    const idf = buildIDF(docs);
    expect(idf.retry, 'a rare term does not outweigh a ubiquitous one')
      .toBeGreaterThan(idf.payments);
  });

  it('a term in no document has no weight at all', () => {
    expect(buildIDF(docs).zzzznotpresent).toBeFalsy();
  });

  it('an empty corpus does not divide by zero', () => {
    expect(() => buildIDF([])).not.toThrow();
  });
});

describe('scoring ranks the document that is actually about the query', () => {
  const docs = [
    { content: 'retry failed charges with backoff' },
    { content: 'weather forecast rendering' },
    { content: 'user profile settings page' },
  ];

  it('the relevant document scores higher than the irrelevant ones', () => {
    const idf = buildIDF(docs);
    const q = tokenize('retry charges backoff');
    const scores = docs.map((d) => scoreDoc(d, q, idf));
    expect(scores[0], 'the document about the query did not score highest')
      .toBeGreaterThan(Math.max(scores[1], scores[2]));
  });

  it('a document sharing no term with the query scores zero, not a small positive', () => {
    const idf = buildIDF(docs);
    expect(scoreDoc({ content: 'nothing in common here' }, tokenize('zzzzq'), idf)).toBe(0);
  });

  it('an unknown query term contributes nothing rather than throwing', () => {
    const idf = buildIDF(docs);
    expect(() => scoreDoc(docs[0], ['zzzznotpresent'], idf)).not.toThrow();
  });
});

describe('the extracted chunk is the part of the document the query is about', () => {
  it('centres on the matching line, not the top of the file', () => {
    const lines = ['intro', 'unrelated', 'unrelated', 'the retry policy lives here', 'unrelated'];
    const chunk = extractChunk({ lines }, tokenize('retry policy'));
    expect(chunk, 'the chunk does not contain the matching line').toContain('retry policy');
  });

  it('an empty document yields an empty chunk rather than throwing', () => {
    expect(extractChunk({ lines: [] }, tokenize('anything'))).toBe('');
  });

  it('a document matching nothing still yields SOMETHING, so a hit is never blank', () => {
    // A scored hit with an empty chunk tells the agent a file is relevant and shows it nothing.
    const chunk = extractChunk({ lines: ['alpha', 'beta', 'gamma'] }, tokenize('zzzzq'));
    expect(chunk.length, 'a hit was returned with no content at all').toBeGreaterThan(0);
  });
});
