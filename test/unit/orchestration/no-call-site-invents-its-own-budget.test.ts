import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// NO CALL SITE INVENTS ITS OWN BUDGET.
//
// A seam's iterations and output tokens are declared in invocation-profiles.json — that is what
// makes "the ladder decides" true. A literal at a call site is a second, invisible budget: it
// outranks the declaration, it never appears in any cost estimate, and changing the seam's
// declared budget silently does nothing to that call.
//
// brownfield-repro-test-writer asked a one-line question with EPAM_MAX_ITERATIONS=3 and
// EPAM_MAX_OUTPUT_TOKENS=256 written inline.
const REPO = process.cwd()
const PROFILES = JSON.parse(readFileSync(join(REPO, 'orchestrations/agents/invocation-profiles.json'), 'utf8'))

function budgetLiterals(): string[] {
  try {
    const out = execFileSync('grep', ['-rnE',
      'EPAM_MAX_ITERATIONS=[0-9]+|EPAM_MAX_OUTPUT_TOKENS=[0-9]+',
      'orchestrations/scripts', '--include=*.sh', '--include=*.js'],
      { cwd: REPO, encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean).filter(l => {
      const body = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1).trim()
      return !(body.startsWith('#') || body.startsWith('//') || body.startsWith('*'))
    })
  } catch (e: any) {
    if (e.status === 1) return []
    throw e
  }
}

describe('no call site invents its own budget', () => {
  it('THE INVARIANT: no executable line sets an iteration or output-token budget as a literal', () => {
    expect(budgetLiterals(),
      'these outrank the seam declaration and appear in no cost estimate. Declare the budget on '
      + 'the seam in invocation-profiles.json and read it.').toEqual([])
  })

  it('the repro-test-writer seam declares its narrow question\'s SIZE — but not its turns', () => {
    const p = PROFILES.profiles['repro-test-writer']
    expect(p, 'repro-test-writer is not a declared seam').toBeTruthy()
    expect(p.microQuestion, 'no declared budget for the seam\'s one-line question').toBeTruthy()
    expect(Number.isFinite(p.microQuestion.maxOutputTokens)).toBe(true)
    // it must stay CHEAPER than the seam's own budget, or it is not a micro question
    expect(p.microQuestion.maxOutputTokens).toBeLessThan(p.maxOutputTokens)

    // THE LADDER OWNS THE TURNS. This used to require maxIterations here too, which is the same
    // defect as the call-site literals this file exists to prevent — a number outranking the
    // seam's ladder rung, only spelled as configuration. Output SIZE is the question's own
    // property; how many turns it may take is not.
    expect(p.microQuestion.maxIterations,
      'a declared iteration budget outranks the ladder rung for this one call').toBeUndefined()
  })
})
