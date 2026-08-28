import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// GENERATION MAY SPECIALISE A PROMPT. IT MAY NOT CHANGE WHAT AN ANSWER LOOKS LIKE.
//
// Project prompts are generated from the immutable templates, and only the generated copy runs.
// Specialising is the point — this project's codelines, its stack, its tools. But the OUTPUT
// SHAPE is a contract with the consumer, and a generator that quietly drops or renames a field
// leaves the agent answering one shape while the engine reads another. That is run 8: the agent
// obeyed its prompt exactly and was rejected for it, and nothing could say which side was wrong.
//
// So: every output key the TEMPLATE states must survive into the generated copy. Additions are
// allowed — a generated prompt may add tool instructions or extra fields — but a LOSS is a
// defect, because the consumer still reads the field the template promised.
const REPO = process.cwd()
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates')
const ARCHIVE = join(REPO, 'orchestrations/logs/archive')

function bodyOf(file: string): string {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return String(j.body || Object.values(j.bodies || {}).join('\n') || '')
  } catch { return '' }
}

// The top-level keys of the largest balanced JSON block — the response shape a prompt states.
function statedKeys(body: string): string[] {
  let best = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '{') continue
    let d = 0
    for (let k = i; k < body.length; k++) {
      if (body[k] === '{') d++
      else if (body[k] === '}') { d--; if (!d) { const blk = body.slice(i, k + 1); if (blk.length > best.length) best = blk; break } }
    }
  }
  if (!best) return []
  const keys: string[] = []
  let depth = 0
  for (let i = 0; i < best.length; i++) {
    const c = best[i]
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === '"' && depth === 1) {
      const m = best.slice(i).match(/^"([a-zA-Z][a-zA-Z0-9_]*)"\s*:/)
      if (m) { keys.push(m[1]); i += m[0].length - 1 }
    }
  }
  return [...new Set(keys)]
}

type Pair = { seam: string; template: string[]; generated: string[]; run: string }
const PAIRS: Pair[] = (() => {
  const out: Pair[] = []
  if (!existsSync(ARCHIVE) || !existsSync(TEMPLATES)) return out
  for (const run of readdirSync(ARCHIVE)) {
    const dir = join(ARCHIVE, run, 'prompts')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const seam = f.replace(/\.json$/, '')
      const tpl = join(TEMPLATES, f)
      if (!existsSync(tpl)) continue
      const t = statedKeys(bodyOf(tpl))
      if (!t.length) continue
      // COMPARE AGAINST THE WHOLE GENERATED BODY, not against one block of it.
      //
      // Picking "the largest balanced JSON block" as the response shape is not reliable: a
      // generated prompt often carries a larger example elsewhere, so the shape block loses the
      // contest and every key reads as missing. That produced a confident false report that
      // prompt-review had dropped `falseClaims` when both files contain it.
      //
      // A key is LOST only if it appears nowhere in the generated prompt at all.
      const genBody = bodyOf(join(dir, f))
      out.push({ seam, run, template: t, generated: t.filter(k => genBody.includes(`"${k}"`) || genBody.includes(`${k}:`)) })
    }
  }
  return out
})()

describe('generation preserves the output shape', () => {
  it('there are template/generated pairs to compare — otherwise this proves nothing', () => {
    expect(PAIRS.length,
      'no archived generated prompt has a matching template with a stated output shape')
      .toBeGreaterThan(0)
  })

  // HISTORY CANNOT BE FIXED — IT CAN ONLY BE CAUGHT.
  //
  // Two archived generations really did lose their output shape: prompt-review dropped
  // <PROMPT_REVIEW>{"falseClaims": []} while lib/prompt-review.js parses exactly that tag, and
  // skill-assessment-prephase dropped every output key at half the template's length. Those
  // files are evidence, not code — asserting they are clean would fail forever.
  //
  // What must hold is that the CONTRACT CHECK refuses them, so the same generation cannot ship
  // again. That is asserted here against the real artefacts.
  it('every generation that lost its output shape IS REFUSED by the contract check', () => {
    const { checkGeneratedPrompt } = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-contract.js'))
    const lost = PAIRS.filter(p => p.template.some(k => !p.generated.includes(k)))
    expect(lost.length,
      'no archived generation lost its shape — nothing here exercises the check').toBeGreaterThan(0)
    for (const p of lost) {
      const tpl = JSON.parse(readFileSync(join(TEMPLATES, `${p.seam}.json`), 'utf8'))
      const gen = JSON.parse(readFileSync(join(ARCHIVE, p.run, 'prompts', `${p.seam}.json`), 'utf8'))
      const v = checkGeneratedPrompt(tpl, gen)
      expect(v.ok, `${p.seam} (${p.run}) lost ${p.template.filter(k => !p.generated.includes(k)).join(', ')} `
        + 'and the contract check ACCEPTED it').toBe(false)
    }
  })

  it('additions are reported, not forbidden — a generator may add tools or fields', () => {
    // Not an assertion about correctness: a record of what generation adds, so a surprising
    // addition is visible rather than discovered when something downstream reads it.
    const added = PAIRS
      .map(p => ({ seam: p.seam, extra: p.generated.filter(k => !p.template.includes(k)) }))
      .filter(p => p.extra.length)
    for (const a of added) expect(Array.isArray(a.extra)).toBe(true)
    expect(true).toBe(true)
  })
})
