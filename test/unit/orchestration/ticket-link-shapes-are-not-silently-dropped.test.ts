/**
 * A CALLER USING THE OTHER SHAPE MUST NOT LOOK LIKE AN UNREACHABLE INTERNET.
 *
 * fetchTicketDocuments required `{url: "..."}` and discarded anything else without a word:
 *
 *     const url = l && typeof l.url === 'string' ? l.url : '';
 *     if (!url || seen.has(url)) continue;          // silent
 *
 * Live 2026-08-07: the agent-mint passed an array of plain URL strings. Every entry failed the
 * type check, the function returned [], and the step reported "documents: 0 fetched of 2
 * link(s)" — which reads as "both sites were down". They were not: the same URL fetches 8105
 * bytes. The project's agent roster was minted with no vendor documentation, and every role it
 * proposed named the wrong product.
 *
 * Two separate defects, and the silence is the worse one: a wrong-shape bug that announces
 * itself is a five-minute fix, while one that mimics a plausible external failure sends you
 * looking at the network.
 *
 * These tests use a stub tool — no network — and assert on what the function DOES with each
 * input shape.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const work = () => { const d = mkdtempSync(join(tmpdir(), 'links-')); dirs.push(d); return d; };

describe('both link shapes are accepted', () => {
  it('an object entry works — the shape the spec pass uses', async () => {
    const out = await spec.fetchTicketDocuments([{ url: 'https://example.invalid/a' }], work());
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://example.invalid/a');
  }, 60_000);

  it('THE DEFECT: a bare STRING entry is accepted, not discarded', async () => {
    const out = await spec.fetchTicketDocuments(['https://example.invalid/b'], work());
    expect(
      out,
      'a plain URL string was dropped, and the caller was told the document was unavailable',
    ).toHaveLength(1);
    expect(out[0].url).toBe('https://example.invalid/b');
  }, 60_000);

  it('mixed shapes both survive', async () => {
    const out = await spec.fetchTicketDocuments(
      ['https://example.invalid/c', { url: 'https://example.invalid/d' }], work());
    expect(out.map((d: any) => d.url).sort()).toEqual(
      ['https://example.invalid/c', 'https://example.invalid/d']);
  }, 60_000);
});

describe('an unusable entry is reported, never swallowed', () => {
  it('it is recorded as not_attempted rather than vanishing', async () => {
    const out = await spec.fetchTicketDocuments([{ notAUrl: true }, 42, null], work());
    expect(
      out.length,
      'unusable entries disappeared, so the count of links no longer matches the count of results',
    ).toBeGreaterThan(0);
    expect(out.every((d: any) => d.fetchStatus === 'not_attempted')).toBe(true);
  }, 60_000);

  it('it warns, so the cause is visible without reading the source', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await spec.fetchTicketDocuments([{ notAUrl: true }], work());
    const said = warn.mock.calls.flat().join(' ');
    warn.mockRestore();
    expect(said, 'nothing was logged when input was discarded').toMatch(/no usable url|skipped/i);
  }, 60_000);
});

describe('duplicates are still collapsed', () => {
  it('the same url twice fetches once', async () => {
    const out = await spec.fetchTicketDocuments(
      ['https://example.invalid/e', { url: 'https://example.invalid/e' }], work());
    expect(out).toHaveLength(1);
  }, 60_000);
});
