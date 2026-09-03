/**
 * THE SHAPE GUARD MUST NOT MISTAKE AN EXAMPLE FOR A CONTRACT.
 *
 * A generated prompt is refused if it drops an output tag the template states, because a consumer
 * looks for exactly that marker. The guard took every <UPPERCASE> in the body.
 *
 * skill-assessment-prephase's instructions contain an example JSONL record —
 * {"timestamp":"<ISO8601>", ...} — where <ISO8601> is a TYPE placeholder inside an illustration,
 * not a marker anything parses. The guard demanded it back verbatim, the generator legitimately
 * rephrased the example, and mock3 run 9 exhausted all three attempts and failed the step after 29
 * prompts had already succeeded.
 *
 * A tag a consumer parses always WRAPS something. Across all templates that separates them
 * exactly: 4 paired (DISCOVERY_VOCABULARY, MODEL_REVIEW, PROMPT_REVIEW, SPEC_REVIEW), 1 unpaired
 * (ISO8601). Pairing is derived from the template, so no exception list can go stale.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkGeneratedPrompt } = require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-contract.js'))

const TPL = {
  id: 't', description: 'd', version: 1, seams: ['s'], placeholders: ['__X__'],
  bodies: { basic: 'Use __X__ and answer in <PROMPT_REVIEW>{"falseClaims":[]}</PROMPT_REVIEW>' },
}
const gen = (body: string) => ({ body, placeholders: TPL.placeholders, seams: TPL.seams, id: TPL.id, description: TPL.description, version: TPL.version })

describe('a response tag is paired, a value placeholder is not', () => {
  it('THE DEFECT: rephrasing an unpaired placeholder inside an example is allowed', () => {
    const t = JSON.parse(readFileSync(join(TEMPLATES, 'skill-assessment-prephase.json'), 'utf8'))
    const body = Object.values(t.bodies as Record<string, string>).join('\n')
    const rephrased = body.replace(/<ISO8601>/g, '2026-08-26T12:00:00Z')
    const r = checkGeneratedPrompt(t, { ...t, body: rephrased })
    expect(r.ok, `still refused: ${r.reason}`).toBe(true)
  })

  it('THE LIMIT: dropping a PAIRED tag is still refused', () => {
    const r = checkGeneratedPrompt(TPL, gen('Use __X__ and answer with falseClaims however you like'))
    expect(r.ok, 'a consumer-parsed tag was allowed to vanish').toBe(false)
    expect(String(r.reason)).toMatch(/PROMPT_REVIEW/)
  })

  it('a kept paired tag passes', () => {
    expect(checkGeneratedPrompt(TPL, gen(TPL.bodies.basic)).ok).toBe(true)
  })

  it('pairing separates the real tags from the placeholders across EVERY template', () => {
    // Derived, so a new template with a new value placeholder cannot silently re-break this.
    const paired = new Set<string>(); const unpaired = new Set<string>()
    for (const f of readdirSync(TEMPLATES).filter((x) => x.endsWith('.json'))) {
      const t = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'))
      const body = String(t.body || Object.values(t.bodies || {}).join('\n') || '')
      for (const tag of new Set(body.match(/<[A-Z][A-Z0-9_]+>/g) || [])) {
        const name = tag.slice(1, -1)
        ;(body.includes(`</${name}>`) ? paired : unpaired).add(name)
      }
    }
    expect(paired.size, 'no paired response tags found — the guard would enforce nothing').toBeGreaterThan(0)
    for (const name of unpaired) {
      expect(paired.has(name), `${name} is both paired and unpaired — pairing no longer separates them`).toBe(false)
    }
  })
})
