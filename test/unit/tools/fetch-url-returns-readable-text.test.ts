/**
 * fetch_url must return READABLE TEXT, and must not spend its budget on markup.
 *
 * The tool's own description says it returns a URL's content "as text". It returned raw
 * HTML and capped at 50,000 characters, so on a real vendor documentation page:
 *
 *   - the 50KB budget was spent mostly on <script>, <style>, nav and inlined data
 *   - the page was TRUNCATED (a live fetch returned exactly 50,026 chars = cap + marker)
 *   - documentation puts API detail partway down, so the part that matters is often past
 *     the cut
 *
 * That is load-bearing here: the ticket-link agent reads vendor docs to establish the real
 * contract of an API a story depends on. On the live ticket, a doc stating that a callback
 * takes NO argument is what refuted a story's central assumption — and a summary or a
 * truncated page cannot support the verbatim quote the agent is required to return.
 *
 * Extracting text first means the same cap carries far more actual documentation.
 */
import { describe, it, expect } from 'vitest';
import { FetchUrlTool } from '../../../src/tools/builtin/FetchUrl';

const tool = new FetchUrlTool();

/** A page shaped like real documentation: heavy markup, the signal buried near the end. */
function htmlPage(signal: string, padKb = 60): string {
  const noise = `<script>${'x'.repeat(1024)}</script><style>${'y'.repeat(1024)}</style>`;
  return `<!DOCTYPE html><html><head><title>Docs</title>${noise.repeat(padKb)}</head>` +
         `<body><nav>${'<a href="#">link</a>'.repeat(200)}</nav>` +
         `<main><h1>Guide</h1><p>Intro paragraph.</p><p>${signal}</p></main>` +
         `<footer>${'z'.repeat(2048)}</footer></body></html>`;
}

function stubFetch(bodyText: string, contentType = 'text/html') {
  return vi.fn(async () => new Response(bodyText, {
    status: 200, headers: { 'content-type': contentType },
  })) as unknown as typeof fetch;
}

import { vi, beforeEach, afterEach } from 'vitest';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('HTML is reduced to its text before any cap is applied', () => {
  it('strips script and style content entirely', async () => {
    globalThis.fetch = stubFetch('<html><body><script>SECRETSCRIPT</script><p>Real prose.</p></body></html>');
    const r = await tool.execute({ url: 'https://example.test/doc' });
    expect(r.content).toMatch(/Real prose/);
    expect(r.content, 'script contents reached the model as if it were documentation').not.toMatch(/SECRETSCRIPT/);
  });

  it('strips tags, leaving the prose', async () => {
    globalThis.fetch = stubFetch('<html><body><h1>Title</h1><p>Body <em>text</em> here.</p></body></html>');
    const r = await tool.execute({ url: 'https://example.test/doc' });
    expect(r.content).toMatch(/Title/);
    expect(r.content).toMatch(/Body text here/);
    expect(r.content, 'raw tags survived').not.toMatch(/<p>|<h1>|<em>/);
  });

  it('THE TRUNCATION: signal buried behind 60KB of markup still survives the cap', async () => {
    const signal = 'onEntryChange takes no argument and the app must re-fetch';
    globalThis.fetch = stubFetch(htmlPage(signal));
    const r = await tool.execute({ url: 'https://example.test/doc' });
    expect(
      r.content,
      'the documentation sentence that matters was cut off because markup consumed the budget',
    ).toMatch(/onEntryChange takes no argument/);
  });

  it('decodes the entities documentation actually uses', async () => {
    globalThis.fetch = stubFetch('<html><body><p>use &lt;Provider&gt; &amp; wrap it&nbsp;here</p></body></html>');
    const r = await tool.execute({ url: 'https://example.test/doc' });
    expect(r.content).toMatch(/use <Provider> & wrap it here/);
  });
});

describe('non-HTML is returned untouched', () => {
  it('JSON is not mangled by text extraction', async () => {
    const body = JSON.stringify({ live_preview: { preview_token: 'x', enable: true } });
    globalThis.fetch = stubFetch(body, 'application/json');
    const r = await tool.execute({ url: 'https://example.test/api' });
    expect(r.content).toMatch(/"preview_token"/);
    expect(() => JSON.parse(r.content.replace(/^HTTP \d+\s*/, ''))).not.toThrow();
  });

  it('plain text is unchanged', async () => {
    globalThis.fetch = stubFetch('just words', 'text/plain');
    const r = await tool.execute({ url: 'https://example.test/t' });
    expect(r.content).toMatch(/just words/);
  });
});

describe('truncation, when it happens, is announced', () => {
  it('an over-long page still says it was cut', async () => {
    globalThis.fetch = stubFetch(`<html><body><p>${'word '.repeat(200000)}</p></body></html>`);
    const r = await tool.execute({ url: 'https://example.test/long' });
    expect(r.content, 'a silently truncated page reads as a complete one').toMatch(/truncated/i);
  });

  it('the cap is configurable rather than fixed', async () => {
    globalThis.fetch = stubFetch(`<html><body><p>${'word '.repeat(5000)}</p></body></html>`);
    const prev = process.env.EPAM_FETCH_MAX_CHARS;
    process.env.EPAM_FETCH_MAX_CHARS = '500';
    try {
      const r = await tool.execute({ url: 'https://example.test/x' });
      expect(r.content.length).toBeLessThan(1200);
    } finally {
      if (prev === undefined) delete process.env.EPAM_FETCH_MAX_CHARS;
      else process.env.EPAM_FETCH_MAX_CHARS = prev;
    }
  });
});

describe('failures are still reported honestly', () => {
  it('a non-ok status is an error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const r = await tool.execute({ url: 'https://example.test/missing' });
    expect(r.isError).toBe(true);
  });

  it('a network failure is an error, not empty content', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const r = await tool.execute({ url: 'https://example.test/x' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ENOTFOUND/);
  });
});
