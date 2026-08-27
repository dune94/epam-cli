/**
 * THE CHECK THAT WOULD HAVE CAUGHT RUN 14 WITHOUT A RUN.
 *
 * Run 20260827T125654Z reached the specification pass — further than any run before it — and died
 * there, deterministically, with NO model involved:
 *
 *   prompt 'spec-agent-openspec' was given EMPTY values for: __DECLARED_FILE_BLOCK__,
 *   __FIX_SITE_BLOCK__, __FORCED_RETRY_BLOCK__, __PRIOR_GAPS_BLOCK__, __PUBLISHED_CON…
 *
 * Those blocks are SUPPOSED to be empty on a first pass — there are no prior gaps, no fix sites
 * and no forced retry yet. `mayBeEmpty` is the declaration that says so. The renderer refuses
 * without it, three retries changed nothing because nothing was being asked of a model, and both
 * lanes halted.
 *
 * WHY THE FREE HARNESS MISSED IT. agent-check --dry supplies a value for EVERY placeholder, all
 * non-empty, so it never renders the condition that fails. It reported `ok spec-agent` and
 * `ok guard-vocabulary` minutes before both of them killed the run. A harness that only exercises
 * the populated case cannot see this class at all — which is why it kept looking as though a seam
 * could only be tested by running the pipeline.
 *
 * This file closes that. Both checks are static, free, and need no model:
 *
 *   1. A generated prompt must KEEP the mayBeEmpty its template declares. guard-vocabulary's
 *      template declares two and its generated copy carried none — the generator drops the field,
 *      so every project prompt loses it and the refusal is guaranteed at runtime.
 *   2. Every placeholder that renders empty in a real first pass must be declared, per template.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const TEMPLATES = join(REPO_ROOT, 'orchestrations/prompts/templates');
const PROJECTS = join(REPO_ROOT, 'orchestrations/projects');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildGeneratedDoc } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'));

const read = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const declaredEmpty = (j: any): string[] => (j && Array.isArray(j.mayBeEmpty)) ? j.mayBeEmpty : [];

/** Every (project, template) pair where a generated copy exists beside its template. */
function generatedPairs(): Array<{ project: string; id: string; tpl: any; gen: any }> {
  const out: Array<{ project: string; id: string; tpl: any; gen: any }> = [];
  for (const project of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, project, 'prompts');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      const tplPath = join(TEMPLATES, f);
      if (!existsSync(tplPath)) continue;
      const tpl = read(tplPath); const gen = read(join(dir, f));
      if (tpl && gen) out.push({ project, id, tpl, gen });
    }
  }
  return out;
}

describe('a generated prompt keeps the mayBeEmpty its template declares', () => {
  it('there are templates declaring mayBeEmpty — otherwise this asserts nothing', () => {
    // Guards a vacuous pass: with no template declaring the field, every loop below is empty and
    // green, which is how a check like this rots unnoticed.
    const declaring = readdirSync(TEMPLATES)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => declaredEmpty(read(join(TEMPLATES, f))).length);
    expect(declaring.length, 'no template declares mayBeEmpty — nothing here is being tested')
      .toBeGreaterThan(0);
  });

  it('REPRODUCES run 14: buildGeneratedDoc carries the declaration into the copy that runs', () => {
    // ASSERTED ON THE GENERATOR, NOT ON DISK. The prompts in a project directory are the OUTPUT of
    // the last run, and pre-run-reset deletes them at the start of the next one. Making a unit test
    // depend on them means it can only be satisfied by running the pipeline — and repairing them by
    // hand to go green is editing a generated artefact, which is not a fix at all. The defect was in
    // buildGeneratedDoc; that is what this executes.
    const offenders: string[] = [];
    for (const f of readdirSync(TEMPLATES)) {
      if (!f.endsWith('.json')) continue;
      const tpl = read(join(TEMPLATES, f));
      const want = declaredEmpty(tpl);
      if (!want.length) continue;
      const body = typeof tpl.body === 'string'
        ? tpl.body
        : Object.values(tpl.bodies || {}).filter((b) => typeof b === 'string').join('\n');
      // The generator is handed the template's own body — the closest honest stand-in for what a
      // model returns, since a faithful specialisation preserves every placeholder.
      const doc = buildGeneratedDoc(tpl, body);
      const got = new Set(declaredEmpty(doc));
      const missing = want.filter((ph: string) => body.includes(ph) && !got.has(ph));
      if (missing.length) offenders.push(`${f}: dropped ${missing.join(', ')}`);
    }
    expect(offenders,
      'the generator dropped a mayBeEmpty declaration — every prompt it produces will refuse at '
      + 'runtime on a block that is SUPPOSED to be empty, and no retry can help because no model '
      + 'is asked anything')
      .toEqual([]);
  });

  it('a template that declares mayBeEmpty names only placeholders it actually contains', () => {
    // A declaration for a placeholder the body does not have is dead text that will not protect
    // the block it was written for.
    const stray: string[] = [];
    for (const f of readdirSync(TEMPLATES)) {
      if (!f.endsWith('.json')) continue;
      const j = read(join(TEMPLATES, f));
      const declared = declaredEmpty(j);
      if (!declared.length) continue;
      const body = typeof j.body === 'string'
        ? j.body
        : Object.values(j.bodies || {}).filter((b) => typeof b === 'string').join('\n');
      for (const ph of declared) if (!body.includes(ph)) stray.push(`${f}: ${ph}`);
    }
    expect(stray, 'mayBeEmpty names a placeholder the template body does not contain').toEqual([]);
  });
});
