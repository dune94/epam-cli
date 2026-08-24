/**
 * EVERY SEAM'S PROMPT REFUSES A BLANK PAYLOAD — ALL 39, NOT A SAMPLE.
 *
 * On 2026-08-23 three seams were found handing an agent a section with nothing in it: the tool
 * grant, the ladder, and the roster reviewer's brief block. Each was "declared and not delivered",
 * each rendered a prompt that looked complete, and each agent then answered truthfully about
 * silence. The roster reviewer blocked a roster twice for briefs that existed.
 *
 * Testing those three individually would not have prevented the fourth. The renderers now refuse a
 * present-but-empty value, and this sweep holds EVERY seam's prompt to it — so a new seam, or a new
 * `|| ''` at a call site, cannot reintroduce the class quietly.
 *
 * WHAT IT DOES. For each seam in the registry it renders that seam's prompt twice: once with every
 * placeholder carrying a real value (must succeed and contain them), and once with one placeholder
 * blank (must refuse, naming it). A placeholder the template declares as `mayBeEmpty` is skipped
 * for the second pass, because absent is a real state for it.
 *
 * ZERO TOKENS. Nothing here calls a model. It exercises the rendering path every agent invocation
 * goes through, which is where all three failures lived.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(join(ROOT, 'orchestrations/scripts/lib/prompt-library.js'));

interface Seam { seam: string; template: string }

/** Every seam that names a prompt — read from the registry, never listed here. */
const seams = (): Seam[] => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const out: Seam[] = [];
  (function walk(o: Record<string, unknown>) {
    for (const k of Object.keys(o)) {
      const v = o[k] as Record<string, unknown>;
      if (v && typeof v === 'object') {
        if (typeof v.template === 'string') out.push({ seam: k, template: v.template });
        walk(v);
      }
    }
  }((reg.profiles || {}) as Record<string, unknown>));
  return out;
};

/** The template document a seam renders, and the parts it is made of. */
const templateDoc = (id: string) => {
  const p = join(TEMPLATES, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
};

/** Each renderable body of a template: one, or one per part. */
const bodiesOf = (t: Record<string, unknown>): Array<{ part: string; body: string }> => {
  if (t.bodies && typeof t.bodies === 'object') {
    return Object.entries(t.bodies as Record<string, string>).map(([part, body]) => ({ part, body }));
  }
  return [{ part: 'body', body: String(t.body || '') }];
};

const ALL = seams();

describe('every seam names a prompt that exists', () => {
  it('the registry declares seams, and each template is on disk', () => {
    expect(ALL.length, 'no seams found — this suite would prove nothing').toBeGreaterThanOrEqual(30);
    const missing = ALL.filter((s) => !templateDoc(s.template)).map((s) => `${s.seam}->${s.template}`);
    expect(missing, `seams naming a template that is not there: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('every seam prompt renders with real values, and refuses blank ones', () => {
  for (const { seam, template } of ALL) {
    it(`${seam} (${template})`, () => {
      const t = templateDoc(template);
      expect(t, `no template for ${seam}`).toBeTruthy();

      const mayBeEmpty: string[] = (t.mayBeEmpty as string[]) || [];

      for (const { part, body } of bodiesOf(t)) {
        const used = [...new Set(lib.placeholdersIn(body))] as string[];
        if (!used.length) continue;

        const doc = { id: template, authority: 'project', body, placeholders: used, mayBeEmpty };

        // 1. REAL VALUES: renders, and every value actually lands in the output.
        const real: Record<string, string> = {};
        used.forEach((p, i) => { real[p] = `VALUE_${i}_FOR_${p.replace(/_/g, '')}`; });
        const rendered = lib.render(doc, real);
        for (const p of used) {
          expect(rendered, `${seam}/${part}: ${p} did not reach the rendered prompt`)
            .toContain(real[p]);
        }
        expect(lib.placeholdersIn(rendered), `${seam}/${part}: a placeholder survived`).toEqual([]);

        // 2. A BLANK VALUE IS REFUSED, one placeholder at a time, naming it. This is the failure
        //    that reached three agents: a section present, its content gone.
        for (const p of used) {
          if (mayBeEmpty.includes(p)) continue;
          const blanked = { ...real, [p]: '' };
          let threw = '';
          try { lib.render(doc, blanked); } catch (e) { threw = (e as Error).message; }
          expect(threw, `${seam}/${part}: an EMPTY ${p} rendered silently instead of being refused`)
            .toContain(p);
        }
      }
    });
  }
});
