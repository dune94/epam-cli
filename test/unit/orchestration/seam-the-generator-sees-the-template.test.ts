/**
 * SEAM: TEMPLATE → GENERATOR PROMPT. THE MODEL MUST BE SHOWN WHAT IT IS ASKED TO REWRITE.
 *
 * 21 of the shipped templates carry `bodies` instead of `body`. renderGeneratorPrompt read
 * template.body — undefined for every one of them — and String.prototype.join(undefined) falls
 * back to its DEFAULT separator, so the generator prompt received the single character "," where
 * the template should have been.
 *
 * The model was asked to rewrite a comma. It could not preserve placeholders it had never seen,
 * the shape guard refused all three attempts for "dropped placeholder(s)", and mock3 runs 9 and 10
 * both aborted at skill-assessment-prephase — each after ~29 single-body templates had generated
 * cleanly. The refusal named the placeholders, never the empty input that caused them to be
 * missing, so the message pointed away from the cause.
 *
 * The fix is that the renderer and the checker read the template the SAME way. These assert that
 * agreement rather than either half alone.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates')
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'), 'utf8')

/** The real templateBodyText, lifted from the builder. */
function bodyText(): (t: unknown) => string {
  const i = SRC.indexOf('function templateBodyText')
  expect(i, 'templateBodyText is gone — the renderer and checker can drift again').toBeGreaterThan(-1)
  // eslint-disable-next-line no-eval
  return eval(`(${SRC.slice(i, SRC.indexOf('\n}\n', i) + 2)})`)
}

const templates = () => readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'))
  .map((f) => ({ id: f.slice(0, -5), doc: JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8')) }))

describe('seam: the generator sees the template', () => {
  it('multi-body templates exist — otherwise this asserts nothing', () => {
    const multi = templates().filter(({ doc }) => !doc.body && doc.bodies)
    expect(multi.length, 'no template uses `bodies`; the defect class is gone').toBeGreaterThan(5)
  })

  it('THE DEFECT: every template yields a non-empty body to the generator', () => {
    const f = bodyText()
    const empty = templates().filter(({ doc }) => !f(doc).trim()).map(({ id }) => id)
    expect(empty, `the generator would be asked to rewrite nothing for: ${empty.join(', ')}`).toEqual([])
  })

  it('every DECLARED placeholder is visible in the body the generator is shown', () => {
    // A placeholder the model never sees is one it cannot preserve, and the guard then refuses the
    // output for "dropping" it — which is what made this look like a model failure.
    const f = bodyText()
    const bad: string[] = []
    for (const { id, doc } of templates()) {
      const body = f(doc)
      for (const ph of doc.placeholders || []) {
        if (!body.includes(ph)) bad.push(`${id} declares ${ph}, which the generator never sees`)
      }
    }
    expect(bad, bad.join('; ')).toEqual([])
  })

  it('join(undefined) is a comma — the trap that caused this', () => {
    // Stated so the next reader does not have to rediscover why an absent body became ",".
    expect('BODY:X'.split('X').join(undefined as unknown as string)).toBe('BODY:,')
  })

  it('a single-body template is unchanged', () => {
    const f = bodyText()
    const t = templates().find(({ doc }) => typeof doc.body === 'string' && doc.body)
    expect(t, 'no single-body template to compare against').toBeTruthy()
    expect(f(t!.doc)).toBe(t!.doc.body)
  })
})
