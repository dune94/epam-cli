/**
 * THE GENERATOR EMBEDS ANOTHER TEMPLATE'S BODY, SO ITS OWN NAMES MUST NOT BE NAMES A TEMPLATE USES.
 *
 * project-prompt-generation renders a template's body INSIDE its own prompt and then substitutes
 * values. Three of its placeholder names were also names templates use:
 *   roster-specialisation  __PROJECT_CONTEXT__, __CODELINE_CONTEXT__, __PREVIOUS_REFUSAL__
 *   project-roster-review  __CODELINE_CONTEXT__
 *   prompt-review          __TEMPLATE_BODY__
 * so the embedded template's OWN placeholders were replaced with real project text before the model
 * saw them — and the agent was then refused for "dropping" tokens that were never in its input.
 * Same shape as the join(undefined) comma: the input was wrong and the refusal described the output.
 *
 * Substituting the body LAST stopped the corruption but not the confusion: the model still saw one
 * name used as a filled slot and as a token to preserve. roster-specialisation refused on every
 * sample at rung 0 until the names were namespaced, then passed — as did project-roster-review.
 *
 * A reserved prefix removes the class by construction. This asserts it stays removed, because the
 * next template to use a plain name would silently reintroduce it and be blamed for the result.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const TEMPLATES = join(REPO_ROOT, 'orchestrations/prompts/templates');
const GEN = 'project-prompt-generation.json';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { placeholdersIn } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

const bodyOf = (j: any): string => (typeof j.body === 'string'
  ? j.body
  : Object.values(j.bodies || {}).filter((b) => typeof b === 'string').join('\n'));
const read = (f: string): any => JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));

describe('the generator cannot collide with a template it specialises', () => {
  const gen = read(GEN);
  const genPlaceholders = placeholdersIn(bodyOf(gen));

  it('every generator placeholder is namespaced', () => {
    expect(genPlaceholders.length, 'the generator has no placeholders — the fixture is wrong')
      .toBeGreaterThan(0);
    const plain = genPlaceholders.filter((p: string) => !p.startsWith('__GEN_'));
    expect(plain, 'a generator placeholder is not namespaced and can collide with a template')
      .toEqual([]);
  });

  it('its declaration matches its body', () => {
    expect([...(gen.placeholders || [])].sort()).toEqual([...genPlaceholders].sort());
  });

  it('REPRODUCES the defect: no template shares a name with the generator', () => {
    const genSet = new Set(genPlaceholders);
    const collisions: string[] = [];
    for (const f of readdirSync(TEMPLATES)) {
      if (!f.endsWith('.json') || f === GEN) continue;
      const shared = placeholdersIn(bodyOf(read(f))).filter((p: string) => genSet.has(p));
      if (shared.length) collisions.push(`${f}: ${shared.join(', ')}`);
    }
    expect(collisions,
      'a template uses a name the generator also uses — its placeholders will be substituted away '
      + 'before the model sees them, and it will be refused for dropping them')
      .toEqual([]);
  });

  it('no template has adopted the reserved prefix', () => {
    // The other direction: a template using __GEN_* would have its token filled by the generator.
    const offenders: string[] = [];
    for (const f of readdirSync(TEMPLATES)) {
      if (!f.endsWith('.json') || f === GEN) continue;
      const used = placeholdersIn(bodyOf(read(f))).filter((p: string) => p.startsWith('__GEN_'));
      if (used.length) offenders.push(`${f}: ${used.join(', ')}`);
    }
    expect(offenders, '__GEN_* is reserved for the generator').toEqual([]);
  });
});
