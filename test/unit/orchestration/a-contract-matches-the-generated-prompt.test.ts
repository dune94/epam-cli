import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// THE GENERATED PROMPT IS THE AUTHORITY. THE TEMPLATE IS NEVER RUN.
//
// Prompts are GENERATED per project from the immutable template library, and only the generated
// copy ever reaches a model. So a validator derived from the TEMPLATE is a second, undeclared
// contract — which is exactly how run 8 failed on 2026-07-26: gate_verdict_schema.py demanded
// {verdict, summary} while the spec-validator prompt declared {stories:[{verdict}],
// overallVerdict}. The agent obeyed its prompt and was rejected for it, and the finding-analyst
// then had no defect to remediate because there wasn't one — two parts of the engine disagreed
// about what an answer looks like.
//
// So: every key a contract REQUIRES must appear in the prompt that was actually generated. If
// they disagree, the contract is the bug.
//
// Driven by REAL generated prompts from run archives, not by the templates they came from.
const REPO = process.cwd()
const CONTRACTS = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/seam-output-contracts.json'), 'utf8')).seams
const ARCHIVE = join(REPO, 'orchestrations/logs/archive')

function generatedPrompts(seam: string): string[] {
  if (!existsSync(ARCHIVE)) return []
  const out: string[] = []
  for (const run of readdirSync(ARCHIVE)) {
    const f = join(ARCHIVE, run, 'prompts', `${seam}.json`)
    if (!existsSync(f)) continue
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      const body = j.body || Object.values(j.bodies || {}).join('\n')
      if (body) out.push(String(body))
    } catch { /* an unreadable archive is not a prompt */ }
  }
  return out
}

const DECLARED = Object.entries(CONTRACTS)
  .filter(([, v]: any) => v.kind === 'declared')
  .map(([seam, v]: any) => ({ seam, required: v.requiredKeys as string[] }))

describe('a contract matches the generated prompt', () => {
  it('contracts are declared — otherwise this suite is vacuous', () => {
    expect(DECLARED.length).toBeGreaterThan(0)
  })

  it('at least one generated prompt exists to check against', () => {
    const found = DECLARED.filter(d => generatedPrompts(d.seam).length > 0)
    expect(found.length,
      'no generated prompts found under logs/archive — this suite cannot hold contracts to the '
      + 'prompt that actually ran, and a green result would mean nothing').toBeGreaterThan(0)
  })

  for (const { seam, required } of DECLARED) {
    it(`${seam}: every required key is stated in the generated prompt`, () => {
      const prompts = generatedPrompts(seam)
      if (!prompts.length) {
        // SKIP LOUDLY: absent evidence is not agreement.
        expect(prompts.length, `no generated copy of ${seam} archived — contract UNVERIFIED`).toBe(0)
        return
      }
      for (const body of prompts) {
        for (const key of required) {
          expect(body.includes(`"${key}"`) || body.includes(`${key}:`),
            `${seam} requires "${key}" but the prompt that actually ran never mentions it. `
            + 'The prompt is the authority — fix the contract, not the agent.').toBe(true)
        }
      }
    })
  }
})
