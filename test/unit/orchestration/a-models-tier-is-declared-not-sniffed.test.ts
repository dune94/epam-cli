import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A MODEL'S TIER IS DECLARED, NOT GUESSED FROM ITS NAME.
//
// isMiniTierModel decided whether a model was the cheap rung by sniffing vendor naming
// conventions: '-mini', '-nano', '-flash', '-haiku', 'minimax-m2'. That is a vendor's naming
// habit encoded as engine logic. It breaks silently in both directions — a cheap model a vendor
// names differently reads as capable, and a capable model that happens to contain '-flash'
// reads as cheap — and the answer feeds story model-assignment.
//
// The tier belongs to the set that declares the model, beside the other per-model facts already
// in modelOverrides.
const REPO = process.cwd()
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js')
const spec = require(RUNNER)

const SETS = ['codemie', 'openrouter', 'mockserver']

function settings(set: string) {
  return JSON.parse(readFileSync(join(REPO, `orchestrations/config/llm-defaults.${set}.json`), 'utf8'))
}

describe("a model's tier is declared, not sniffed", () => {
  it('THE INVARIANT: the engine names no vendor model convention when deciding tier', () => {
    const src = readFileSync(RUNNER, 'utf8')
    const fn = src.slice(src.indexOf('function isMiniTierModel'), src.indexOf('function isMiniTierModel') + 900)
    expect(fn, 'the tier decision still sniffs vendor naming conventions')
      .not.toMatch(/-mini|-nano|-flash|-haiku|minimax-m2/i)
  })

  it('every set declares at least one mini-tier model — otherwise nothing is ever cheap', () => {
    for (const s of SETS) {
      const mo = settings(s).modelOverrides || {}
      const mini = Object.entries(mo).filter(([k, v]: any) => !k.startsWith('$') && v && v.miniTier === true)
      expect(mini.length, `${s} declares no miniTier model`).toBeGreaterThan(0)
    }
  })

  it('a declared mini-tier model IS mini', () => {
    for (const s of SETS) {
      const mo = settings(s).modelOverrides || {}
      for (const [name, v] of Object.entries(mo) as any) {
        if (name.startsWith('$') || !v || v.miniTier !== true) continue
        expect(spec.isMiniTierModel(name, s), `${s}/${name} declared miniTier but not reported as mini`).toBe(true)
      }
    }
  })

  it('an undeclared model is NOT mini — the engine never guesses', () => {
    // deliberately vendor-shaped names that the old sniff would have matched
    for (const m of ['some-flash-model', 'vendor-haiku-9', 'minimax-m2-lookalike', 'gpt-nano-2']) {
      expect(spec.isMiniTierModel(m, 'codemie'), `${m} was guessed as mini from its name`).toBe(false)
    }
  })

  it('an explicitly named mini model via env still qualifies — that behaviour is unchanged', () => {
    const prev = process.env.ORCH_MINI_MODEL
    process.env.ORCH_MINI_MODEL = 'operator-named-model'
    try {
      expect(spec.isMiniTierModel('operator-named-model', 'codemie')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.ORCH_MINI_MODEL; else process.env.ORCH_MINI_MODEL = prev
    }
  })
})
