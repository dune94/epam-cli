import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// EVERY VERDICT-PRODUCING SEAM, HELD TO THE VERDICT CONTRACT.
//
// A gate whose verdict is unreadable is a gate that fails OPEN: the caller sees no refusal and
// carries on. These seams are enumerated from the shipped registry by what they PRODUCE, so a
// new gate is covered the day it is declared rather than the day someone remembers this file.
const REPO = process.cwd()
const VALIDATOR = join(REPO, 'orchestrations/scripts/lib/gate_verdict_schema.py')
const PROFILES = JSON.parse(readFileSync(join(REPO, 'orchestrations/agents/invocation-profiles.json'), 'utf8'))

const VERDICT_SEAMS: string[] = Object.entries(PROFILES.profiles)
  .filter(([, v]: any) => /verdict|findings|report/i.test(String(v.produces || '')))
  .map(([k]) => k)
  .sort()

function validate(gate: string, text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'))
  const f = join(dir, 'log')
  writeFileSync(f, text)
  const r = spawnSync('python3', [VALIDATOR, gate, f], { encoding: 'utf8', timeout: 20000 })
  rmSync(dir, { recursive: true, force: true })
  return { ok: r.status === 0, reason: (r.stdout || '').trim(), status: r.status }
}

// Observed failure shapes, not invented ones: a model narrating, a model announcing it wrote a
// file instead of answering, a model emitting an unlisted verdict word, and silence.
const BAD: Array<[string, string]> = [
  ['silence', ''],
  ['whitespace only', '   \n  \n'],
  ['prose with no JSON', 'I need to create a valid JSON file. Let me fix the formatting:'],
  ['a claim that it wrote a file', 'The verdict has been written to verdict.json'],
  ['JSON with no verdict field', '{"agent":"x","summary":"looks fine","findings":[]}'],
  ['an unlisted verdict word', '{"agent":"x","verdict":"probably-fine","summary":"s","findings":[]}'],
]

describe('every verdict agent refuses a broken verdict', () => {
  it('the registry yields verdict seams — otherwise this suite is vacuous', () => {
    expect(VERDICT_SEAMS.length, 'no verdict-producing seams found in invocation-profiles.json')
      .toBeGreaterThan(0)
  })

  it('a WELL-FORMED verdict is accepted — or every refusal below proves nothing', () => {
    const good = '{"agent":"qa-gate:sast","verdict":"pass","summary":"no issues","findings":[]}'
    expect(validate('qa-gate:sast', good).ok, 'the validator rejects even a valid verdict').toBe(true)
  })

  describe.each(VERDICT_SEAMS)('%s', (seam) => {
    it.each(BAD)('refuses %s', (_label, text) => {
      const v = validate(seam, text)
      expect(v.ok, `${seam} ACCEPTED a verdict that breaks the contract`).toBe(false)
      expect(v.reason, `${seam} refused without telling the model how to fix it`).not.toBe('')
    })
  })
})
