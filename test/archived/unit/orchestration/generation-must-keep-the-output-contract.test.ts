import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// THE GENERATOR MAY SPECIALISE A PROMPT. IT MAY NOT CHANGE WHAT AN ANSWER LOOKS LIKE.
//
// checkGeneratedPrompt verified placeholders four ways and never looked at the output shape, so
// two real generations shipped with the contract removed:
//
//   prompt-review            lost <PROMPT_REVIEW>{"falseClaims": []}</PROMPT_REVIEW> — and
//                            lib/prompt-review.js:59 parses exactly that tag, so the reviewer's
//                            answer could never be read.
//   skill-assessment-prephase lost every output key (timestamp, agent_role, skill_category,
//                            event); the generated body was half the template's length.
//
// Both are the run-8 shape: the agent obeys its prompt and the engine reads something else.
const REPO = process.cwd()
const { checkGeneratedPrompt } = require(join(REPO, 'orchestrations/scripts/lib/project-prompt-contract.js'))
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates')
const ARCHIVE = join(REPO, 'orchestrations/logs/archive')

function load(f: string): any { return JSON.parse(readFileSync(f, 'utf8')) }
function bodyOf(j: any): string { return String(j.body || Object.values(j.bodies || {}).join('\n') || '') }

// Real generated copies from run archives. Fresh ones cannot be produced without an agentic
// run, so these are the only genuine evidence available.
function archived(seam: string): Array<{ run: string; doc: any }> {
  if (!existsSync(ARCHIVE)) return []
  const out: Array<{ run: string; doc: any }> = []
  for (const run of readdirSync(ARCHIVE)) {
    const f = join(ARCHIVE, run, 'prompts', `${seam}.json`)
    if (existsSync(f)) { try { out.push({ run, doc: load(f) }) } catch { /* unreadable */ } }
  }
  return out
}

describe('generation must keep the output contract', () => {
  it('the two real regressions are REFUSED', () => {
    const cases = ['prompt-review', 'skill-assessment-prephase']
    let checked = 0
    for (const seam of cases) {
      const tplFile = join(TEMPLATES, `${seam}.json`)
      if (!existsSync(tplFile)) continue
      const tpl = load(tplFile)
      for (const { run, doc } of archived(seam)) {
        // only the generations that actually lost the shape
        const lost = !bodyOf(doc).includes('<PROMPT_REVIEW>') && bodyOf(tpl).includes('<PROMPT_REVIEW>')
          || (seam === 'skill-assessment-prephase' && !bodyOf(doc).includes('agent_role'))
        if (!lost) continue
        checked += 1
        const v = checkGeneratedPrompt(tpl, doc)
        expect(v.ok, `${seam} (${run}) lost its output contract and was ACCEPTED`).toBe(false)
        expect(String(v.reason)).toMatch(/output|shape|contract|answer/i)
      }
    }
    expect(checked, 'neither regression was found in the archives — this proves nothing').toBeGreaterThan(0)
  })

  it('a FAITHFUL generation is still accepted — the check must not reject good work', () => {
    let accepted = 0
    for (const run of existsSync(ARCHIVE) ? readdirSync(ARCHIVE) : []) {
      const dir = join(ARCHIVE, run, 'prompts')
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        const tplFile = join(TEMPLATES, f)
        if (!existsSync(tplFile)) continue
        const tpl = load(tplFile); const doc = load(join(dir, f))
        const t = bodyOf(tpl); const g = bodyOf(doc)
        const tags = t.match(/<[A-Z][A-Z_]+>/g) || []
        if (tags.length && tags.every(x => g.includes(x))) {
          const v = checkGeneratedPrompt(tpl, doc)
          if (v.ok) accepted += 1
        }
      }
    }
    expect(accepted, 'no faithful generation passed — the check has become a blanket refusal')
      .toBeGreaterThan(0)
  })
})
