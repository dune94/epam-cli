/**
 * NO AGENT IS HANDED A BLANK PAYLOAD.
 *
 * Three failures on 2026-08-23, one shape:
 *
 *   the tool grant   declared on the seam, passed into the storyId slot, never delivered
 *   the ladder       declared on the seam, read from an env the caller never exported
 *   the brief block  written by the mint, looked up in the wrong map, rendered as a blank line
 *
 * Each was "declared and not delivered". Each produced a prompt that LOOKED complete — the header
 * was there, the section was there, the value was empty — and the agent then reported truthfully
 * about what it was given. The roster reviewer blocked a roster twice for briefs that existed.
 *
 * The renderer could not catch any of them because it only refuses a MISSING key. `|| ''` turns a
 * failed lookup into a present-but-empty value, which passes every check and reaches the model as
 * silence. Fifteen call sites in this pipeline supply a placeholder value that way.
 *
 * So an empty value is refused, and a placeholder that may legitimately be empty says so IN THE
 * TEMPLATE — the file that owns the prompt — as `mayBeEmpty`. A retry note absent on a first
 * attempt is legitimately empty; a brief is not. The distinction belongs with the prompt, not in
 * the producer's head.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'probe',
  authority: 'project',
  body: 'BEFORE\n__PAYLOAD__\nAFTER',
  placeholders: ['__PAYLOAD__'],
  ...over,
});

describe('an empty value is refused, not rendered as silence', () => {
  it('refuses an empty string for a declared placeholder', () => {
    expect(() => lib.render(doc(), { __PAYLOAD__: '' }))
      .toThrow(/__PAYLOAD__/);
  });

  it('refuses whitespace, which reads as empty to a model', () => {
    expect(() => lib.render(doc(), { __PAYLOAD__: '   \n  ' }))
      .toThrow(/__PAYLOAD__/);
  });

  it('names the placeholder, so the producer is findable', () => {
    let msg = '';
    try { lib.render(doc(), { __PAYLOAD__: '' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('__PAYLOAD__');
    expect(msg, 'the refusal does not say the value was empty rather than missing')
      .toMatch(/empty|blank/i);
  });

  it('renders normally when the value is real', () => {
    expect(lib.render(doc(), { __PAYLOAD__: 'the actual payload' }))
      .toContain('the actual payload');
  });
});

describe('a placeholder that may legitimately be empty declares it', () => {
  it('honours mayBeEmpty from the template that owns the prompt', () => {
    // A retry note is absent on a first attempt. That is a real state, and the prompt itself is
    // the right place to say so — not the producer, which is where the knowledge got lost.
    const out = lib.render(doc({ mayBeEmpty: ['__PAYLOAD__'] }), { __PAYLOAD__: '' });
    expect(out).toContain('BEFORE');
    expect(out).toContain('AFTER');
  });

  it('and mayBeEmpty covers only what it names', () => {
    const two = doc({
      body: 'A __ONE__ B __TWO__',
      placeholders: ['__ONE__', '__TWO__'],
      mayBeEmpty: ['__ONE__'],
    });
    expect(() => lib.render(two, { __ONE__: '', __TWO__: '' })).toThrow(/__TWO__/);
    expect(lib.render(two, { __ONE__: '', __TWO__: 'x' })).toContain('x');
  });
});

describe('every shipped template is honest about what may be empty', () => {
  it('mayBeEmpty, where declared, names only placeholders the template uses', () => {
    // A template exempting a placeholder it does not have is a stale exemption, and the next
    // blank payload slips through under a name nobody reads.
    const bad: string[] = [];
    for (const f of readdirSync(TEMPLATES).filter((x) => x.endsWith('.json'))) {
      const t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
      const declared: string[] = t.mayBeEmpty || [];
      if (!declared.length) continue;
      const bodies: string[] = t.bodies ? Object.values(t.bodies) : [String(t.body || '')];
      const text = bodies.join('\n');
      for (const p of declared) if (!text.includes(p)) bad.push(`${f}:${p}`);
    }
    expect(bad, `templates exempting a placeholder they do not use: ${bad.join(', ')}`).toEqual([]);
  });
});
