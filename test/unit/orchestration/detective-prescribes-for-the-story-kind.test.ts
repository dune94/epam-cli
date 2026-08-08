/**
 * A FEATURE HAS NO BROKEN LINE, AND ASKING FOR ONE GETS YOU HALF THE WORK.
 *
 * Live 2026-08-08, AMSD-2041 across three codelines. The detective returned ONE fix site —
 * the Contentstack.Stack() init — for a story that also needs a provider wrapped around the
 * app and onEntryChange wired into every fetch surface. The pipeline noticed and said so
 * ("Single fix site prescribed but work spans 5+ files across 3 codelines"), then proceeded.
 *
 * It was not a model failure. The prompt asks for exactly what it got:
 *
 *     "PRESCRIBE THE MINIMAL FIX … State the SMALLEST change that corrects it"
 *     "As SOON as you identify a file whose function body computes the wrong value, STOP"
 *     "SHOW THE BROKEN CODE — brokenLine is REQUIRED and is machine-verified"
 *     "If you cannot point at a real line that is wrong, you have not found the cause yet"
 *
 * Every one of those is right for a defect and wrong for a feature. Nothing is broken in
 * AMSD-2041, so there is no line to quote; the only site expressible under that contract is
 * the one place existing code is touched. The wiring half cannot be said at all.
 *
 * A kind hint already existed (inferStoryKindHint: Jira "Bug" → defect, else novel) and the
 * prompt branched on it — for ONE paragraph. The forty lines after it, including the
 * machine-verified broken-line requirement, applied unconditionally, so the defect contract
 * dominated a story already classified novel.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');

describe('the fixture is real', () => {
  it('the prescription block is exported and differs by kind', () => {
    expect(typeof spec.detectivePrescription).toBe('function');
    expect(spec.detectivePrescription('defect')).not.toBe(spec.detectivePrescription('novel'));
  });
});

describe('a DEFECT still gets the contract that works', () => {
  const p = () => spec.detectivePrescription('defect');

  it('asks for the minimal fix at the causal site', () => {
    expect(p()).toMatch(/MINIMAL FIX/i);
    expect(p()).toMatch(/SMALLEST change/i);
  });

  it('still requires the broken line, machine-verified', () => {
    expect(p()).toMatch(/brokenLine/);
    expect(p()).toMatch(/machine-verified|checked/i);
  });

  it('still tells it to stop as soon as the causal site is found', () => {
    expect(p()).toMatch(/STOP/);
  });
});

describe('a NOVEL story gets a contract that fits it', () => {
  const p = () => spec.detectivePrescription('novel');

  it('does NOT demand a broken line — there is nothing broken to quote', () => {
    expect(
      p(),
      'a feature has no wrong expression; demanding one forces the single site where existing ' +
      'code is touched and silently drops every other layer',
      // the defect contract's exact demand; the novel text says "is NOT required", which is
      // the opposite and must not trip this
    ).not.toMatch(/"brokenLine" is REQUIRED/);
  });

  it('does NOT ask for the smallest possible change', () => {
    expect(p()).not.toMatch(/SMALLEST change/i);
  });

  it('asks for EVERY attachment point, not one', () => {
    expect(p()).toMatch(/every|all /i);
    expect(p()).toMatch(/attachment point/i);
  });

  it('asks for the whole span — setup, whatever carries it, and every use', () => {
    // The live miss was exactly this: the setup site was found and everything downstream of
    // it dropped. Stated as a SHAPE so it holds for a repository of any architecture.
    const t = p();
    expect(t).toMatch(/set up|configur/i);
    expect(t).toMatch(/carries it|between/i);
    expect(t).toMatch(/everywhere it is used|every place that reads/i);
  });

  it('tells it to cover the surfaces the acceptance criteria name', () => {
    expect(
      p(),
      'the criteria are the definition of done; a site list that does not cover them is half a job',
    ).toMatch(/acceptance criteria|verification criteria/i);
  });

  it('still forbids inventing files — the reality anchor is not defect-specific', () => {
    expect(p()).toMatch(/do not invent|never .* invent|prove/i);
  });

  it('still asks what to REUSE rather than rewrite', () => {
    expect(p()).toMatch(/reuse/i);
  });
});

describe('the prescription names no stack, framework or vendor', () => {
  // Added 2026-08-08 after review. The first version of the novel branch listed the layers by
  // name — provider, root component, middleware, hooks, page and component call sites. That is
  // a front-end SPA shape. It fit the three codelines in front of me, which is exactly why it
  // read as correct and why it is the defect this pipeline keeps producing: a literal true of
  // THIS estate written into the engine, where it silently becomes true of every estate.
  // Point it at a service, a batch job or an API and those words name nothing.
  //
  // The instruction must be a SHAPE argument — walk outward from where the capability is
  // configured to everywhere it is consumed — and let the investigation discover what those
  // places are called in the repository it is actually looking at.
  // Architectural nouns: checked case-insensitively — they only ever name a structure.
  const ARCHITECTURE_NOUNS = [
    'provider', 'root component', 'middleware', 'hook', 'hooks',
    'plugin registry', 'call site',
  ];
  // Product names: checked CASE-SENSITIVELY, because the lowercase forms are ordinary English
  // ("must react when it changes", "the next call"). Matching those would forbid plain prose.
  const PRODUCT_NAMES = ['React', 'Next.js', 'Vue', 'Angular', 'Django', 'Rails', 'Spring'];

  it.each(ARCHITECTURE_NOUNS)('the novel prescription does not name "%s"', (word) => {
    const t = spec.detectivePrescription('novel').toLowerCase();
    expect(t, `"${word}" presumes an architecture; a repo without one gets a worse answer`)
      .not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it.each(PRODUCT_NAMES)('the novel prescription does not name the product "%s"', (name) => {
    expect(spec.detectivePrescription('novel')).not.toContain(name);
  });

  it('the defect prescription is equally free of both', () => {
    const t = spec.detectivePrescription('defect');
    for (const w of ARCHITECTURE_NOUNS) expect(t.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    for (const n of PRODUCT_NAMES) expect(t).not.toContain(n);
  });

  it('it still asks for the full span, in shape terms rather than names', () => {
    const t = spec.detectivePrescription('novel');
    expect(t).toMatch(/configur/i);            // where it is set up
    expect(t).toMatch(/consum|read|use/i);     // everywhere it is used
    expect(t).toMatch(/every|all /i);
  });

  it('it tells the agent to use the repository\'s OWN terms', () => {
    expect(spec.detectivePrescription('novel')).toMatch(/this (repository|codebase)|its own/i);
  });
});

describe('an unknown kind is treated as the safer one', () => {
  it('defaults to the novel contract rather than demanding a broken line', () => {
    // Guessing "defect" invents a cause for work that has none — the more expensive error.
    expect(spec.detectivePrescription('')).toBe(spec.detectivePrescription('novel'));
  });
});
