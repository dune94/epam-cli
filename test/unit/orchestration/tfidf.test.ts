/**
 * Unit tests for orchestrations/scripts/lib/tfidf.js
 *
 * Covers pure functions used in CPA knowledge-base retrieval:
 *   - tokenize     : text → filtered token array
 *   - computeTF    : tokens → term frequency map
 *   - buildIDF     : corpus → inverse document frequency map
 *   - scoreDoc     : doc + query terms + idf → relevance score
 *   - extractChunk : doc + query terms → best matching text chunk
 */
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { tokenize, computeTF, buildIDF, scoreDoc, extractChunk } = require(
  '../../../orchestrations/scripts/lib/tfidf.js'
);

// ── tokenize ───────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    const tokens = tokenize('Hello World');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
  });

  it('removes stopwords', () => {
    const tokens = tokenize('the quick brown fox');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
  });

  it('filters tokens shorter than 3 chars', () => {
    const tokens = tokenize('a ab abc abcd');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('ab');
    expect(tokens).toContain('abc');
    expect(tokens).toContain('abcd');
  });

  it('strips code fences', () => {
    const tokens = tokenize('typescript\n```\nconst x = 1;\n```\norchestration');
    expect(tokens).not.toContain('const');
    expect(tokens).toContain('typescript');
    expect(tokens).toContain('orchestration');
  });

  it('strips inline code', () => {
    const tokens = tokenize('call `spawnSync` carefully');
    expect(tokens).not.toContain('spawnsync');
    expect(tokens).toContain('carefully');
  });

  it('converts markdown links to text only', () => {
    const tokens = tokenize('[estimation guide](http://example.com/guide)');
    expect(tokens).toContain('estimation');
    expect(tokens).toContain('guide');
    expect(tokens).not.toContain('http');
  });

  it('splits on hyphens and underscores', () => {
    const tokens = tokenize('cost-estimation story_type');
    expect(tokens).toContain('cost');
    expect(tokens).toContain('estimation');
    expect(tokens).toContain('story');
    expect(tokens).toContain('type');
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('removes code stopwords (const, let, var, return)', () => {
    const tokens = tokenize('const result = return value let x var y');
    expect(tokens).not.toContain('const');
    expect(tokens).not.toContain('return');
    expect(tokens).not.toContain('let');
    expect(tokens).not.toContain('var');
    expect(tokens).toContain('result');
    expect(tokens).toContain('value');
  });
});

// ── computeTF ──────────────────────────────────────────────────────────────

describe('computeTF', () => {
  it('returns frequency relative to total tokens', () => {
    const tf = computeTF(['apple', 'apple', 'banana']);
    expect(tf['apple']).toBeCloseTo(2 / 3);
    expect(tf['banana']).toBeCloseTo(1 / 3);
  });

  it('returns 1.0 for a single unique token', () => {
    const tf = computeTF(['solo']);
    expect(tf['solo']).toBe(1.0);
  });

  it('returns empty object for empty tokens array', () => {
    expect(computeTF([])).toEqual({});
  });

  it('handles all identical tokens', () => {
    const tf = computeTF(['cat', 'cat', 'cat', 'cat']);
    expect(tf['cat']).toBe(1.0);
  });
});

// ── buildIDF ───────────────────────────────────────────────────────────────

describe('buildIDF', () => {
  const docs = [
    { content: 'authentication token jwt bearer', source: 'auth.md', lines: [] },
    { content: 'authentication oauth provider flow', source: 'oauth.md', lines: [] },
    { content: 'database query sql index', source: 'db.md', lines: [] },
  ];

  it('returns higher IDF for rare terms', () => {
    const idf = buildIDF(docs);
    // 'jwt' appears in 1/3 docs; 'authentication' appears in 2/3 docs
    // rare term should have higher IDF
    expect(idf['jwt']).toBeGreaterThan(idf['authentication']);
  });

  it('returns positive IDF values for all terms', () => {
    const idf = buildIDF(docs);
    for (const val of Object.values(idf)) {
      expect(val).toBeGreaterThan(0);
    }
  });

  it('returns {} for empty corpus', () => {
    expect(buildIDF([])).toEqual({});
  });

  it('uses smoothed IDF (no zero scores for terms in all docs)', () => {
    const allDocs = [
      { content: 'shared term here', source: 'a.md', lines: [] },
      { content: 'shared term there', source: 'b.md', lines: [] },
    ];
    const idf = buildIDF(allDocs);
    // 'shared' and 'term' appear in both docs — smoothed IDF should be > 0
    expect(idf['shared']).toBeGreaterThan(0);
    expect(idf['term']).toBeGreaterThan(0);
  });
});

// ── scoreDoc ───────────────────────────────────────────────────────────────

describe('scoreDoc', () => {
  const docs = [
    { content: 'cost estimation story effort agile sprint', source: 'a.md', lines: [] },
    { content: 'database schema migration postgres index', source: 'b.md', lines: [] },
    { content: 'cost budget forecast pricing model', source: 'c.md', lines: [] },
  ];
  const idf = buildIDF(docs);

  it('returns higher score for more relevant document', () => {
    const queryTerms = tokenize('cost estimation');
    const scoreA = scoreDoc(docs[0], queryTerms, idf);
    const scoreB = scoreDoc(docs[1], queryTerms, idf);
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('returns 0 for a document with no query term overlap', () => {
    const queryTerms = ['zzznomatch'];
    const score = scoreDoc(docs[0], queryTerms, idf);
    expect(score).toBe(0);
  });

  it('returns non-negative scores', () => {
    const queryTerms = tokenize('estimation cost story');
    for (const doc of docs) {
      expect(scoreDoc(doc, queryTerms, idf)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── extractChunk ───────────────────────────────────────────────────────────

describe('extractChunk', () => {
  it('returns empty string for doc with no lines', () => {
    const doc = { content: '', source: 'empty.md', lines: [] };
    expect(extractChunk(doc, ['query'])).toBe('');
  });

  it('returns content when query terms are not found (falls back to line 0)', () => {
    const lines = ['Line one content', 'Line two content', 'Line three content'];
    const doc = { content: lines.join('\n'), source: 'doc.md', lines };
    const chunk = extractChunk(doc, ['zzznomatch']);
    expect(typeof chunk).toBe('string');
    expect(chunk.length).toBeGreaterThan(0);
  });

  it('selects chunk containing the matching term', () => {
    const lines = [
      'Introduction to the system',
      'This section covers authentication',
      'JWT tokens are used for auth',
      'The token expiry is 24 hours',
      'Unrelated database section',
    ];
    const doc = { content: lines.join('\n'), source: 'doc.md', lines };
    const chunk = extractChunk(doc, tokenize('jwt token authentication'));
    expect(chunk).toContain('JWT');
  });

  it('starts chunk from nearest heading before best line', () => {
    const lines = [
      '## Authentication',
      'Some intro text',
      'More intro text',
      'JWT tokens are issued here',
      'Token lifetime is configured',
      '## Database',
      'Unrelated content',
    ];
    const doc = { content: lines.join('\n'), source: 'doc.md', lines };
    const chunk = extractChunk(doc, tokenize('jwt tokens'));
    // Should start from the ## Authentication heading
    expect(chunk).toContain('## Authentication');
  });

  it('boosts heading lines over body lines with same hits', () => {
    const lines = [
      '## Cost Estimation Guide',
      'Some unrelated body text here',
      'More unrelated content about other topics',
    ];
    const doc = { content: lines.join('\n'), source: 'doc.md', lines };
    const chunk = extractChunk(doc, tokenize('cost estimation'));
    expect(chunk).toContain('## Cost Estimation Guide');
  });
});
