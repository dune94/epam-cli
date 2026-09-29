/**
 * THE BOOTSTRAP REVIEWER'S PROMPT IS RENDERED — NOT SENT WITH ITS PLACEHOLDERS LITERAL.
 *
 * Prompts are reviewed as they are generated, so on a fresh project the first ones are judged by a
 * reviewer whose own project copy does not exist yet; lib/prompt-review.js then renders the reviewer
 * from its template (operator, 2026-09-08). That path called substituteOnce(body, values) against a
 * signature of (body, keys, values): `keys` was the values object, `keys.length` undefined, and the
 * body came back untouched. Every bootstrap review was sent "__TEMPLATE_BODY__" where the template
 * under review should have been, "__GENERATED_BODY__" for the prompt it was judging, and a literal
 * "__PERSONA__" (found by the rehearsal's persona check, 2026-09-29).
 *
 * Executed: the real makePromptReviewer on its bootstrap path (the project copy missing), with the
 * real template, capturing the prompt its invoke is handed.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { makePromptReviewer } = require(join(LIB, 'prompt-review.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { placeholdersIn } = require(join(LIB, 'engine-prompt.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { templatePersona } = require(join(LIB, 'template-persona.js'));
const tpl = JSON.parse(readFileSync(join(ROOT, 'orchestrations/prompts/templates/prompt-review.json'), 'utf8'));
const body = String(tpl.body || Object.values(tpl.bodies || {}).join('\n'));

async function bootstrapPrompt(values: Record<string, string>) {
  let sent = '';
  const review = makePromptReviewer({
    render: () => { throw new Error('project-authority prompt missing: /nowhere/prompts/prompt-review.json'); },
    invoke: async (prompt: string) => { sent = prompt; return '{"verdict":"sound","findings":[]}'; },
    values: () => values,
    logPathFor: () => '/dev/null',
    warn: () => {},
  });
  await review({ id: 'some-prompt', template: { body: 'T' }, generated: 'G' });
  return sent;
}

describe('the bootstrap reviewer prompt', () => {
  const names = placeholdersIn(body) as string[];
  const supplied = Object.fromEntries(names.filter((p) => p !== '__PERSONA__').map((p) => [p, `«${p.replace(/_/g, '')}»`]));

  it('the template has placeholders to prove this on', () => expect(names.length).toBeGreaterThan(1));

  it('every value the caller supplies reaches the prompt, and no placeholder is sent literally', async () => {
    const sent = await bootstrapPrompt(supplied);
    expect(sent, 'nothing was sent to the reviewer').not.toBe('');
    for (const v of Object.values(supplied)) expect(sent).toContain(v);
    expect(placeholdersIn(sent), 'placeholders reached the model literally').toEqual([]);
  });

  it('with no persona from the caller, the reviewer speaks as its declared persona', async () => {
    const want = String(templatePersona('prompt-review') || '').trim();
    expect(want, 'prompt-review declares no persona the profiles carry').not.toBe('');
    expect(await bootstrapPrompt({ ...supplied, __PERSONA__: '' })).toContain(want);
  });

  it('a persona the caller supplies wins', async () => {
    const sent = await bootstrapPrompt({ ...supplied, __PERSONA__: 'CALLER-SUPPLIED-PERSONA' });
    expect(sent).toContain('CALLER-SUPPLIED-PERSONA');
  });
});
