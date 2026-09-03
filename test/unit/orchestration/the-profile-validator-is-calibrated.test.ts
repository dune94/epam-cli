import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THE GUARD THAT REFUSES TO INVOKE AN AGENT ON AN INCOMPLETE PROFILE.
//
// agent_profile_validate returns 2 when a role is unknown or its profile is missing a required
// parameter, because "an incomplete profile would run at provider defaults" — a budget nobody
// chose. It is the check standing between a misdeclared seam and a call that silently runs on
// whatever the vendor felt like. It had no test.
//
// Driven against a REGISTRY BUILT HERE, so the assertions are about the validator rather than
// about whichever seams happen to be declared today.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib/agent-invoke.sh')
const REQUIRED = ['maxOutputTokens', 'reasoningEffort', 'timeoutSecs', 'captureCost']

function validate(profiles: any, role: string) {
  const dir = mkdtempSync(join(tmpdir(), 'profval-'))
  const reg = join(dir, 'invocation-profiles.json')
  writeFileSync(reg, JSON.stringify({ defaults: {}, profiles }, null, 2))
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; agent_profile_validate ${JSON.stringify(role)}; echo "rc=$?"`],
    { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, AGENT_PROFILES_REGISTRY: reg, EPAM_MODEL_ITERATIONS: '' } })
  rmSync(dir, { recursive: true, force: true })
  const m = (r.stdout || '').match(/rc=(\d+)/)
  return { rc: m ? Number(m[1]) : -1, out: (r.stdout || '') + (r.stderr || '') }
}

const COMPLETE = {
  maxOutputTokens: 32768, reasoningEffort: 'medium', timeoutSecs: 300, captureCost: true,
}

describe('the profile validator is calibrated', () => {
  it('ACCEPTS a complete profile — a guard that always refuses stops every run', () => {
    const v = validate({ 'some-seam': { ...COMPLETE } }, 'some-seam')
    expect(v.rc, `a complete profile was refused: ${v.out}`).toBe(0)
  })

  it('REFUSES an unknown role, and says where to declare it', () => {
    const v = validate({ 'some-seam': { ...COMPLETE } }, 'not-declared')
    expect(v.rc).toBe(2)
    expect(v.out).toMatch(/unknown agent role/i)
    expect(v.out, 'the refusal must name the registry, or nobody can act on it')
      .toMatch(/invocation-profiles\.json/)
  })

  // EVERY required key, one at a time: a validator that checks only the first is a validator
  // that passes a profile missing the rest.
  it.each(REQUIRED)('REFUSES a profile missing %s', (key) => {
    const partial: any = { ...COMPLETE }
    delete partial[key]
    const v = validate({ 'some-seam': partial }, 'some-seam')
    expect(v.rc, `a profile with no ${key} was accepted — it would run at provider defaults`).toBe(2)
    expect(v.out).toContain(key)
  })

  it('names EVERY missing parameter, not just the first', () => {
    const v = validate({ 'some-seam': { captureCost: true } }, 'some-seam')
    expect(v.rc).toBe(2)
    // reporting one at a time turns a single fix into three round trips
    for (const k of ['maxOutputTokens', 'reasoningEffort', 'timeoutSecs']) {
      expect(v.out, `${k} was missing but not reported`).toContain(k)
    }
  })
})
