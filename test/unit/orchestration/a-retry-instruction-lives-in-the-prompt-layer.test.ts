/**
 * THE TEXT A MODEL IS TOLD TO CORRECT ITSELF WITH IS A PROMPT, AND PROMPTS LIVE IN FILES.
 *
 * project-prompt-builder.js appended its retry instruction in JavaScript:
 *
 *   out += `\n\n## Your previous attempt was REFUSED\n\n${refusal}\n\n`
 *        + 'Produce the prompt again, correcting exactly this. Change nothing else.';
 *
 * That is model-facing prose in engine code — unreviewable in the prompt layer, invisible to the
 * drift checks that hold every project copy to its template, and unchangeable per project. The
 * sibling seam already does it correctly: roster-specialisation.json declares
 * __PREVIOUS_REFUSAL__ and the roster stage fills it.
 *
 * The rule is one prompt, one file. A retry instruction is not an exception because it is short.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const BUILDER = join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js');
const TEMPLATE = join(ROOT, 'orchestrations/prompts/templates/project-prompt-generation.json');

const code = () => readFileSync(BUILDER, 'utf8').split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('the generator prompt carries its own retry instruction', () => {
  it('the template declares a refusal placeholder', () => {
    const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
    expect(doc.placeholders, 'the generator template declares no placeholders').toBeTruthy();
    expect(doc.placeholders).toContain('__PREVIOUS_REFUSAL__');
    expect(doc.body).toContain('__PREVIOUS_REFUSAL__');
  });

  it('the builder no longer writes instruction prose in JavaScript', () => {
    expect(code()).not.toMatch(/Produce the prompt again/);
    expect(code()).not.toMatch(/Your previous attempt was REFUSED/);
  });

  it('a refusal still reaches the model, and an absent one leaves no scar', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { renderGeneratorPrompt } = require(BUILDER);
    const generatorBody = 'BODY __TEMPLATE_ID__\n__PREVIOUS_REFUSAL__';
    const template = { id: 't', body: 'b', placeholders: [] };

    const withRefusal = renderGeneratorPrompt({
      generatorBody, template, projectContext: '', codelineContext: '', mintedRoles: '',
      refusal: 'you dropped __X__',
    });
    expect(withRefusal, 'the refusal never reached the prompt').toContain('you dropped __X__');

    const without = renderGeneratorPrompt({
      generatorBody, template, projectContext: '', codelineContext: '', mintedRoles: '',
    });
    // No placeholder left behind, and no empty "REFUSED" heading on a first attempt.
    expect(without).not.toContain('__PREVIOUS_REFUSAL__');
    expect(without).not.toMatch(/REFUSED/);
  });
});

describe('one refusal block serves every seam that retries', () => {
  // It existed at three call sites in three wordings. A seam that words it differently teaches a
  // different lesson for the same event, and none of the three could be reviewed as a prompt.
  const LIB = join(ROOT, 'orchestrations/scripts/lib/refusal-block.js');

  it('renders the block from the template when there is a reason', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { refusalBlock } = require(LIB);
    const out = refusalBlock('you dropped __X__', 'roster');
    expect(out).toContain('you dropped __X__');
    expect(out).toContain('roster');
    expect(out).toContain('REFUSED');
  });

  it('renders NOTHING when there is no reason', () => {
    // An agent told it was refused, with nothing after it, invents a reason.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { refusalBlock } = require(LIB);
    for (const nothing of ['', '   ', undefined, null]) {
      expect(refusalBlock(nothing as unknown as string, 'roster')).toBe('');
    }
  });

  it('no seam writes the wording itself any more', () => {
    for (const f of ['orchestrations/scripts/mint-agents-step.js',
      'orchestrations/scripts/lib/project-prompt-builder.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8').split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      expect(src, `${f} still writes refusal prose in JavaScript`)
        .not.toMatch(/previous attempt was REFUSED/i);
    }
  });
});

describe('the naming refusal is a prompt, not a string in the roster module', () => {
  // Both branches were prose in agent-roster.js: the sentence naming the required endings, and
  // the shapeless one used when the registry could not be read. The SHAPES are derived; only the
  // words moved.
  const ROSTER = join(ROOT, 'orchestrations/scripts/lib/agent-roster.js');
  const TPL = join(ROOT, 'orchestrations/prompts/templates/agent-name-refusal.json');

  it('the template carries both wordings', () => {
    const doc = JSON.parse(readFileSync(TPL, 'utf8'));
    expect(Object.keys(doc.bodies || {}).sort()).toEqual(['shapes', 'unknown']);
    expect(doc.bodies.shapes).toContain('__KIND__');
    expect(doc.bodies.shapes).toContain('__SHAPES__');
  });

  it('the roster module writes neither sentence', () => {
    const src = readFileSync(ROSTER, 'utf8').split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(src).not.toMatch(/must be named ending in/);
    expect(src).not.toMatch(/Rename it with the ending/);
  });

  it('and the rendered refusal still names the kind and the endings', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { renderEngineTemplate } = require(join(ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));
    const out = renderEngineTemplate('agent-name-refusal',
      { __KIND__: 'investigator', __SHAPES__: '"-detective"' }, 'shapes');
    expect(out).toContain('investigator');
    expect(out).toContain('-detective');
  });
});
