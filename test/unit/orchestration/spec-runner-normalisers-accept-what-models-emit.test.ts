/**
 * THE NORMALISERS BETWEEN A MODEL'S ANSWER AND THE PIPELINE'S DATA.
 *
 * Every one of these takes text or JSON a model produced and turns it into something the pipeline
 * relies on. They are the seam where a correct answer gets silently destroyed: a wrapper key nobody
 * anticipated, a boolean expressed as a word, a quote list of objects instead of strings. The answer
 * arrives, the normaliser drops it, and nothing downstream can tell the difference between "the
 * model said nothing" and "we threw it away".
 *
 * These functions were 231 lines with no test at all. The shapes below are the ones a model really
 * emits — the alternate key names are read off the implementation's own alias lists, not invented,
 * because a fixture I made up would only confirm my assumptions.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
const { normaliseTicketLinks, coveringTestFiles, parseDetectiveFindings } = runner;

describe('normaliseTicketLinks accepts the shapes a model really returns', () => {
  it('a bare array of link objects', () => {
    const out = normaliseTicketLinks([{ url: 'https://x/1', classification: 'spec' }]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://x/1');
    expect(out[0].classification).toBe('spec');
  });

  it('wrapped under the key the TOOL DEFINITION declares, not a guessed alias', () => {
    // The implementation reads the array's key off TOOL_TICKET_LINKS rather than a hand-written
    // list of likely names — a vocabulary in engine code is wrong for the next tool and maintained
    // by nobody. So the declared key must work whatever it happens to be called.
    const props = (runner.TOOL_TICKET_LINKS.parameters || {}).properties || {};
    const declaredKey = Object.keys(props).find((k) => props[k].type === 'array');
    expect(declaredKey, 'the tool declares no array parameter; this test would prove nothing')
      .toBeTruthy();
    const out = normaliseTicketLinks({ [declaredKey!]: [{ url: 'https://x/2' }] });
    expect(out.map((l: any) => l.url)).toEqual(['https://x/2']);
  });

  it('wrapped under ANY single object-valued key the model invented', () => {
    const out = normaliseTicketLinks({ whateverTheModelCalledIt: [{ url: 'https://x/3' }] });
    expect(out.map((l: any) => l.url)).toEqual(['https://x/3']);
  });

  it('nested several levels down', () => {
    const out = normaliseTicketLinks({ result: { data: { items: [{ url: 'https://x/4' }] } } });
    expect(out.map((l: any) => l.url)).toEqual(['https://x/4']);
  });

  it('but NOT past the depth limit — it stops rather than searching forever', () => {
    const deep = { a: { b: { c: { d: { e: { f: [{ url: 'https://x/deep' }] } } } } } };
    expect(normaliseTicketLinks(deep)).toEqual([]);
  });

  it('relevance as a boolean, as a word, and absent', () => {
    const rows = normaliseTicketLinks([
      { url: 'https://a', relevant: false },
      { url: 'https://b', relevant: true },
      { url: 'https://c', relevance: 'not relevant' },
      { url: 'https://d', relevance: 'irrelevant' },
      { url: 'https://e', relevance: 'relevant' },
      { url: 'https://f' },
    ]);
    const byUrl = Object.fromEntries(rows.map((r: any) => [r.url, r.relevant]));
    expect(byUrl['https://a']).toBe(false);
    expect(byUrl['https://b']).toBe(true);
    expect(byUrl['https://c'], '"not relevant" was read as relevant').toBe(false);
    expect(byUrl['https://d'], '"irrelevant" was read as relevant').toBe(false);
    expect(byUrl['https://e']).toBe(true);
    // A link returned at all, with no verdict, is not a denial.
    expect(byUrl['https://f'], 'absence of a verdict was treated as "not relevant"').toBe(true);
  });

  it('quotes as flat strings and as objects carrying the quote', () => {
    const [flat] = normaliseTicketLinks([{ url: 'https://a', quotes: ['one', 'two'] }]);
    expect(flat.quotes).toEqual(['one', 'two']);
    const [objs] = normaliseTicketLinks([{
      url: 'https://b',
      key_findings: [{ quote: 'q1', note: 'n' }, { text: 'q2' }, { excerpt: 'q3' }],
    }]);
    expect(objs.quotes, 'quotes returned as objects were dropped').toEqual(['q1', 'q2', 'q3']);
  });

  it('a contradiction as a sentence, and as a structured list', () => {
    const [sentence] = normaliseTicketLinks([
      { url: 'https://a', contradictsStory: 'the ticket says X' }]);
    expect(sentence.contradictsStory).toBe('the ticket says X');

    const [structured] = normaliseTicketLinks([{
      url: 'https://b',
      contradictions_with_ticket: [
        { ticket_says: 'A', document_says: 'B', explanation: 'they differ' }],
    }]);
    expect(structured.contradictsStory, 'a structured contradiction was thrown away')
      .toContain('ticket says: A');
    expect(structured.contradictsStory).toContain('document says: B');
    expect(structured.contradictsStory).toContain('they differ');
  });

  it('fetchStatus distinguishes an EMPTY review from an UNREAD one', () => {
    // The distinction the schema forces the agent to make: a downstream reader must be able to tell
    // "the agent opened it and found nothing" from "the agent never opened it".
    const [read] = normaliseTicketLinks([{ url: 'https://a', fetch_status: 'ok' }]);
    expect(read.fetchStatus).toBe('ok');
    const [unread] = normaliseTicketLinks([{ url: 'https://b' }]);
    expect(unread.fetchStatus, 'an unattempted fetch is indistinguishable from a successful one')
      .toBe('not_attempted');
  });

  it('drops entries with no url, and refuses non-objects entirely', () => {
    expect(normaliseTicketLinks([{ classification: 'spec' }, { url: '' }, null, 'text'])).toEqual([]);
    expect(normaliseTicketLinks(null)).toEqual([]);
    expect(normaliseTicketLinks('a string')).toEqual([]);
    expect(normaliseTicketLinks(42)).toEqual([]);
  });

  it('falls back through every declared alias for url, classification and reason', () => {
    const [a] = normaliseTicketLinks([{ link: 'https://via-link', type: 'design', note: 'because' }]);
    expect(a.url).toBe('https://via-link');
    expect(a.classification).toBe('design');
    expect(a.reason).toBe('because');
    const [b] = normaliseTicketLinks([{ href: 'https://via-href', category: 'api', summary: 's' }]);
    expect(b.url).toBe('https://via-href');
    expect(b.classification).toBe('api');
    expect(b.reason).toBe('s');
    const [c] = normaliseTicketLinks([{ url: 'https://c' }]);
    expect(c.classification, 'an unclassified link got a blank rather than "unknown"').toBe('unknown');
  });
});

describe('parseDetectiveFindings keeps what the prompt asked the model for', () => {
  it('returns null when there is no JSON array at all', () => {
    expect(parseDetectiveFindings('no json here', '')).toBeNull();
    expect(parseDetectiveFindings('', '')).toBeNull();
    expect(parseDetectiveFindings(null, '')).toBeNull();
  });

  it('returns null on a malformed array rather than throwing', () => {
    expect(parseDetectiveFindings('[{ broken json', '')).toBeNull();
    expect(parseDetectiveFindings('[{"file": }]', '')).toBeNull();
  });

  it('finds the array embedded in surrounding prose, which is how models answer', () => {
    const out = parseDetectiveFindings(
      `Here is what I found:\n[{"file":"src/a.ts","reason":"r"}]\nHope that helps.`, '');
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe('src/a.ts');
  });

  it('de-duplicates by file and strips a leading ./', () => {
    const out = parseDetectiveFindings(
      '[{"file":"./src/a.ts"},{"file":"src/a.ts"},{"file":"/src/b.ts"}]', '');
    expect(out.map((f: any) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips entries with no file, which cannot be acted on', () => {
    const out = parseDetectiveFindings('[{"reason":"r"},{"file":123},{"file":"src/a.ts"}]', '');
    expect(out.map((f: any) => f.file)).toEqual(['src/a.ts']);
  });

  it('coerces every declared field to a string rather than passing a number through', () => {
    const out = parseDetectiveFindings(
      '[{"file":"src/a.ts","function":5,"reason":null,"fix":{"a":1}}]', '');
    expect(out[0].function).toBe('');
    expect(out[0].reason).toBe('');
    expect(out[0].fix).toBe('');
  });

  it('fileVerified is null with no repo, and a real boolean with one', () => {
    // The provenance a feature has instead of a broken line: does the file you named exist.
    const none = parseDetectiveFindings('[{"file":"src/a.ts"}]', '');
    expect(none[0].fileVerified, 'an unverifiable claim was reported as verified').toBeNull();

    const repo = mkdtempSync(join(tmpdir(), 'detective-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/real.ts'), 'export const x = 1;\n');
    const out = parseDetectiveFindings(
      '[{"file":"src/real.ts"},{"file":"src/invented.ts"}]', repo);
    const byFile = Object.fromEntries(out.map((f: any) => [f.file, f.fileVerified]));
    expect(byFile['src/real.ts']).toBe(true);
    expect(byFile['src/invented.ts'], 'a diagnosis about a file that does not exist passed as real')
      .toBe(false);
  });
});

describe('coveringTestFiles resolves imports rather than matching basenames', () => {
  function repoWith(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'covering-'));
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    execFileSync('git', ['-C', dir, 'init', '--quiet']);
    execFileSync('git', ['-C', dir, 'add', '-A']);
    return dir;
  }

  it('finds a test that imports the declared file relatively', () => {
    const dir = repoWith({
      'src/services/thing.ts': 'export const a = 1;\n',
      'src/services/thing.test.ts': "import { a } from './thing';\n",
    });
    expect(coveringTestFiles(dir, ['src/services/thing.ts']))
      .toEqual(['src/services/thing.test.ts']);
  });

  it('does NOT accept an unrelated file that merely shares a basename', () => {
    // The defect this exists to stop: matching on basename accepted "constants/<module>" and
    // "interface/<module>" as covering "services/<module>.ts" — 21 unrelated suites for one file,
    // which would have handed the writer a manifest naming most of the test tree.
    const dir = repoWith({
      'src/services/thing.ts': 'export const a = 1;\n',
      'src/constants/thing.ts': 'export const b = 2;\n',
      'src/constants/thing.test.ts': "import { b } from './thing';\n",
    });
    expect(coveringTestFiles(dir, ['src/services/thing.ts']),
      'a test for a different module with the same basename was claimed as covering').toEqual([]);
  });

  it('accepts a non-relative alias import only when the declared path ENDS with it', () => {
    const dir = repoWith({
      'src/services/thing.ts': 'export const a = 1;\n',
      'src/services/thing.spec.ts': "import { a } from 'services/thing';\n",
      'src/other/wrong.spec.ts': "import { a } from 'constants/thing';\n",
    });
    const out = coveringTestFiles(dir, ['src/services/thing.ts']);
    expect(out).toContain('src/services/thing.spec.ts');
    expect(out, 'an alias that does not match the declared path was accepted')
      .not.toContain('src/other/wrong.spec.ts');
  });

  it('honours a configured test-file pattern instead of a built-in one', () => {
    const dir = repoWith({
      'src/thing.ts': 'export const a = 1;\n',
      'src/thing.checks.ts': "import { a } from './thing';\n",
    });
    expect(coveringTestFiles(dir, ['src/thing.ts']),
      'the default pattern matched a name it should not').toEqual([]);
    expect(coveringTestFiles(dir, ['src/thing.ts'],
      { ...process.env, EPAM_TEST_FILE_PATTERN: '\\.checks\\.[jt]sx?$' } as any))
      .toEqual(['src/thing.checks.ts']);
  });

  it('returns nothing, without throwing, when there is no repo or nothing declared', () => {
    // A manifest without a covering test is a fact, not an error.
    expect(coveringTestFiles('', ['src/a.ts'])).toEqual([]);
    expect(coveringTestFiles('/definitely/not/a/repo', ['src/a.ts'])).toEqual([]);
    const dir = repoWith({ 'src/a.ts': 'export const a = 1;\n' });
    expect(coveringTestFiles(dir, [])).toEqual([]);
    expect(coveringTestFiles(dir, null as any)).toEqual([]);
    expect(coveringTestFiles(dir, [null, 42, ''] as any)).toEqual([]);
  });

  it('never reports the declared file itself as its own test', () => {
    const dir = repoWith({
      'src/a.test.ts': "import { x } from './a';\n",
      'src/a.ts': 'export const x = 1;\n',
    });
    expect(coveringTestFiles(dir, ['src/a.test.ts'])).toEqual([]);
  });
});
