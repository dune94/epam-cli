/**
 * A GENERATED PROJECT PROMPT HONOURS ITS TEMPLATE.
 *
 * Operator design, 2026-08-15: the agent that mints the roster also BUILDS this project's
 * prompts. Templates are generic and immutable; the project-authority copies are generated
 * from them and are the only thing ever rendered (prompt-library.js refuses to run a
 * template, with no fallback).
 *
 * THE BOOTSTRAP EXCEPTION. Two prompts cannot be generated, because generating them would
 * require themselves: the mint's own prompt (agent-proposal) and the prompt that builds
 * prompts (project-prompt-generation). Those are COPIED verbatim at pre-launch. Which ones
 * are bootstrap is DECLARED in orchestrations/prompts/bootstrap.json — not a list buried in
 * a script, because a hardcoded set silently stops matching the templates beside it.
 *
 * WHY A CONTRACT AND NOT JUST A PROMPT. Rendering is strict in both directions: every
 * declared placeholder must appear in the body, every placeholder in the body must be
 * declared, and every one must be supplied at render time. So a generated prompt that adds,
 * drops or renames a single placeholder does not degrade — it throws mid-run, after the
 * roster is minted and the run is already underway. The generator's output is therefore
 * checked against its template before it is accepted, and the check is code, not persuasion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const BOOTSTRAP = join(ROOT, 'orchestrations/prompts/bootstrap.json');
const CONTRACT = join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js');

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const placeholdersIn = (b: string) =>
  [...new Set(String(b).match(/__[A-Z][A-Z0-9_]*__/g) || [])].sort();

describe('the bootstrap set is declared, not hardcoded', () => {
  it('bootstrap.json exists in the prompt zone', () => {
    expect(existsSync(BOOTSTRAP), 'nothing declares which prompts are copied').toBe(true);
  });

  it('names the two prompts that cannot generate themselves', () => {
    const d = readJson(BOOTSTRAP);
    expect(Array.isArray(d.copyVerbatim)).toBe(true);
    expect(d.copyVerbatim).toContain('agent-proposal');
    expect(d.copyVerbatim).toContain('project-prompt-generation');
  });

  it('every declared bootstrap prompt has a template to copy', () => {
    // A declaration naming a template that does not exist fails at pre-launch, when the
    // operator is waiting, rather than here.
    for (const id of readJson(BOOTSTRAP).copyVerbatim) {
      expect(existsSync(join(TEMPLATES, `${id}.json`)), `no template for '${id}'`).toBe(true);
    }
  });

  it('declares WHY each one is bootstrap, so the list cannot grow by habit', () => {
    const d = readJson(BOOTSTRAP);
    for (const id of d.copyVerbatim) {
      expect(String(d.why?.[id] || ''), `no rationale recorded for '${id}'`).not.toBe('');
    }
  });
});

describe('the prompt that builds prompts exists', () => {
  const P = join(TEMPLATES, 'project-prompt-generation.json');

  it('the template exists', () => {
    expect(existsSync(P), 'nothing generates project prompts').toBe(true);
  });

  it('is handed the template and the project context as values', () => {
    const d = readJson(P);
    expect(d.placeholders).toEqual(placeholdersIn(d.body));
    expect(d.placeholders.length, 'a generator with no inputs cannot specialise anything')
      .toBeGreaterThan(0);
  });

  it('orders every placeholder preserved verbatim — the render is strict', () => {
    const body = readJson(P).body as string;
    expect(body).toMatch(/placeholder/i);
    expect(body, 'must forbid inventing or dropping placeholders')
      .toMatch(/never (add|invent|remove|drop)|do not (add|invent|remove|drop)/i);
  });

  it('names no project, stack or role of its own', () => {
    const body = readJson(P).body as string;
    for (const lit of ['metrolinx', 'gotransit', 'upexpress', 'contentstack', 'Next.js', 'React']) {
      expect(body, `the generator hardcodes '${lit}'`).not.toContain(lit);
    }
  });
});

describe('the contract that checks a generated prompt', () => {
  const contract = () => require(CONTRACT);

  it('the library exists', () => {
    expect(existsSync(CONTRACT), 'generation is unchecked').toBe(true);
  });

  it('ACCEPTS a generated prompt whose placeholders match its template', () => {
    const r = contract().checkGeneratedPrompt(
      { id: 'x', body: 'Do __A__ then __B__.', placeholders: ['__A__', '__B__'] },
      { id: 'x', body: 'Specialised: do __A__ carefully, then __B__.', placeholders: ['__A__', '__B__'] },
    );
    expect(r.ok, r.reason).toBe(true);
  });

  it('REJECTS a dropped placeholder — the value would have nowhere to go', () => {
    const r = contract().checkGeneratedPrompt(
      { id: 'x', body: 'Do __A__ then __B__.', placeholders: ['__A__', '__B__'] },
      { id: 'x', body: 'Specialised: do __A__.', placeholders: ['__A__'] },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('__B__');
  });

  it('REJECTS an invented placeholder — nothing will supply it and render throws', () => {
    const r = contract().checkGeneratedPrompt(
      { id: 'x', body: 'Do __A__.', placeholders: ['__A__'] },
      { id: 'x', body: 'Do __A__ using __C__.', placeholders: ['__A__', '__C__'] },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('__C__');
  });

  it('REJECTS a body that declares placeholders it does not use', () => {
    // prompt-library throws on this too; catching it at generation names the generator
    // instead of failing three stages later with no author.
    const r = contract().checkGeneratedPrompt(
      { id: 'x', body: 'Do __A__.', placeholders: ['__A__'] },
      { id: 'x', body: 'Do __A__.', placeholders: ['__A__', '__B__'] },
    );
    expect(r.ok).toBe(false);
  });

  it('REJECTS an empty or whitespace body', () => {
    for (const body of ['', '   \n ']) {
      const r = contract().checkGeneratedPrompt(
        { id: 'x', body: 'Do __A__.', placeholders: ['__A__'] },
        { id: 'x', body, placeholders: ['__A__'] },
      );
      expect(r.ok, `empty body accepted: ${JSON.stringify(body)}`).toBe(false);
    }
  });

  it('records what it was derived from, so drift is detectable later', () => {
    const r = contract().buildGeneratedDoc(
      { id: 'x', body: 'Do __A__.', placeholders: ['__A__'], version: 3 },
      'Specialised: do __A__ carefully.',
    );
    expect(r.derivedFromSha256, 'no provenance recorded').toBeTruthy();
    expect(r.id).toBe('x');
    expect(r.placeholders).toEqual(['__A__']);
    // Same template + same body => same digest, so a later check is meaningful.
    const again = contract().buildGeneratedDoc(
      { id: 'x', body: 'Do __A__.', placeholders: ['__A__'], version: 3 },
      'Specialised: do __A__ carefully.',
    );
    expect(again.derivedFromSha256).toBe(r.derivedFromSha256);
  });
});

describe('every template is either generated or declared bootstrap', () => {
  it('no template is silently unaccounted for', () => {
    // The failure this prevents: adding a template nobody provisions, so the run dies with
    // "project-authority prompt missing" at the seam that needed it.
    const ids = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    const boot: string[] = readJson(BOOTSTRAP).copyVerbatim;
    const generated: string[] = readJson(BOOTSTRAP).generated || [];
    const unaccounted = ids.filter((id) => !boot.includes(id) && !generated.includes(id));
    expect(unaccounted, `templates nothing provisions: ${unaccounted.join(', ')}`).toEqual([]);
  });
});
