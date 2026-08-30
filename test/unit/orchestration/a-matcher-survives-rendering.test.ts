/**
 * RETEST OF a347d9f AND 0d25753 — rehearsal-harness fixes shipped with no test.
 *
 * The rehearsal replays real captures through mockserver so the pipeline can be exercised for
 * nothing. Its expectations have to MATCH the request the pipeline actually sends, and the two
 * commits describe how they stopped doing so:
 *
 *   a347d9f — nine seams matched on a template line containing a __PLACEHOLDER__, which exists
 *             only BEFORE substitution. The rendered prompt never contains it, so the expectation
 *             never matched, the request fell to the catch-all, and the seam reported its own
 *             required field as missing. Every fault was in the harness; the pipeline was
 *             correctly refusing bad input each time.
 *
 *   0d25753 — spec-agent is called from two places with different templates, so a matcher keyed on
 *             a template fingerprint identified only one of them. outputContractFor() appends the
 *             seam's output TAG to every prompt it sends, so the tag is the one thing common to
 *             all of them.
 *
 * The property both fixes share: a matcher may only rely on text that survives rendering.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/mock-expectations.js'), 'utf8');

const { declaredContracts } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');

describe('a matcher survives rendering', () => {
  it('the seam mark is the capture TAG, falling back to the seam key', () => {
    // 0d25753: keyed on the tag, which outputContractFor appends to every prompt for that seam —
    // not on a template fingerprint, which differs between the two callers of spec-agent.
    expect(SRC, 'the matcher no longer derives its mark from the capture tag')
      .toMatch(/_seamMark\s*=\s*_capTag\s*\|\|\s*key/);
  });

  it('the matcher is built from the seam mark, not from template text', () => {
    expect(SRC).toMatch(/regex:\s*`\(\?s\)\(\?=\.\*\$\{rx\(wireForm\(_seamMark\)\)\}/);
  });

  it('no REGISTERED matcher contains a __PLACEHOLDER__ — asserted on the artefact', async () => {
    // a347d9f, checked against what MockServer actually holds rather than against the source that
    // builds it. A grep over source passes on a comment or a dead branch; these are the matchers
    // the pipeline's requests are really compared against.
    //
    // Skipped loudly when MockServer is not running, rather than passing on an empty list.
    let expectations: any[] = [];
    try {
      const res = await fetch(
        'http://localhost:1080/mockserver/retrieve?type=ACTIVE_EXPECTATIONS&format=JSON',
        { method: 'PUT' });
      expectations = await res.json();
    } catch {
      expect.fail('MockServer is not reachable on :1080 — this assertion cannot run, and passing '
        + 'it on an empty list would report coverage that does not exist');
    }
    expect(expectations.length, 'no expectations are registered; nothing is under test')
      .toBeGreaterThan(10);

    const offenders = expectations
      .map((e) => JSON.stringify(e?.httpRequest?.body ?? {}))
      .filter((b) => /__[A-Z][A-Z0-9_]*__/.test(b));
    expect(offenders, `these matchers key on text that only exists BEFORE rendering, so they can `
      + `never match a real request:\n${offenders.slice(0, 3).join('\n')}`).toEqual([]);
  }, 60_000);

  it('every seam the registry declares has a tag or a key to match on', () => {
    // The harness cannot key on a tag a seam does not declare, so this is the precondition that
    // makes the tag rule usable at all. A seam with neither would fall back to the catch-all —
    // the exact failure a347d9f describes.
    const seams = Object.entries<any>(declaredContracts() || {});
    expect(seams.length, 'no seams declared — nothing under test').toBeGreaterThan(10);
    const unusable = seams.filter(([name, c]) => !name && !(c && (c.tag || c.kind)));
    expect(unusable, 'a seam with nothing to match on falls through to the catch-all').toEqual([]);
  });
});
