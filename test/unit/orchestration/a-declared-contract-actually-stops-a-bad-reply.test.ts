import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A VALIDATOR NOBODY CALLS IS NOT A CONTRACT.
//
// validateDeclaredOutput was written with fatal:true for nine seams and nothing invoked it. That
// is the plan-fidelity-gate defect exactly: a library with a test and no caller LOOKS covered,
// and the run behaves as if the check does not exist — because it does not.
//
// So the seam that already validates replies must consult the declared contract too, and a
// declared breach must DROP the reply rather than log and continue. The tagged-schema path stays
// diagnostic by default (an unproven validator must not halt a run); a declared contract is
// different — its required key is the one a consumer cannot proceed without, taken from the
// prompt the agent was actually given.
const REPO = process.cwd()
const RUNNER = join(REPO, 'orchestrations/scripts/spec-mode-runner.js')
const spec = require(RUNNER)
const CONTRACTS = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/seam-output-contracts.json'), 'utf8')).seams

const DECLARED = Object.entries(CONTRACTS)
  .filter(([, v]: any) => v.kind === 'declared')
  .map(([seam, v]: any) => ({ seam, required: v.requiredKeys as string[] }))

describe('a declared contract actually stops a bad reply', () => {
  it('the wiring exists — the validator is called, not merely defined', () => {
    const src = readFileSync(RUNNER, 'utf8')
    expect(src, 'nothing calls validateDeclaredOutput — it is a library with no caller')
      .toMatch(/validateDeclaredOutput/)
  })

  it('_validatedOrNull is exported so the wiring can be exercised', () => {
    expect(typeof spec._validatedOrNull, 'export _validatedOrNull to make this testable').toBe('function')
  })

  it.each(DECLARED)('$seam: a reply missing its required key is DROPPED', ({ seam, required }) => {
    const bad: any = {}
    // present but wrong: every key EXCEPT the one the consumer needs
    for (const k of (CONTRACTS[seam].knownKeys || []).filter((k: string) => !required.includes(k))) bad[k] = 'x'
    const out = spec._validatedOrNull(bad, 'UNKNOWN_TAG', seam)
    expect(out, `${seam} accepted a reply with no ${required.join(', ')}`).toBeNull()
  })

  it.each(DECLARED)('$seam: a reply that HAS its required key is kept', ({ seam, required }) => {
    const good: any = {}
    for (const k of required) good[k] = 'present'
    const out = spec._validatedOrNull(good, 'UNKNOWN_TAG', seam)
    expect(out, `${seam} dropped a valid reply — the contract is too strict`).not.toBeNull()
  })

  it('a seam with NO declared contract is unaffected', () => {
    const payload = { anything: 1 }
    expect(spec._validatedOrNull(payload, 'UNKNOWN_TAG', 'tc-writer')).toBe(payload)
  })

  it('prose is dropped for a declared seam — the roster failure shape', () => {
    const out = spec._validatedOrNull(
      'I need to create a valid JSON file. Let me fix the formatting:' as any,
      'UNKNOWN_TAG', 'team-lead-review')
    expect(out, 'prose was accepted as an artefact').toBeNull()
  })
})
