/**
 * rosterMode=canonical MUST NOT DISCARD THE MINT.
 *
 * The mode exists to skip the SPECIALISER — "the most expensive seam in a run (top ladder, 65536
 * output tokens, up to 250 turns)", per mock3's own $rosterModeWhy. The mint is a separate,
 * earlier, cheaper step, and what it produces — this project's implementers and per-codeline
 * investigators — exists nowhere in canonical, because those roles are project-specific by nature.
 *
 * Discarding them made a project declaring this mode unrunnable. Live 2026-08-26, mock3 run 6:
 * the mint created fare-schedule-engineer, registered it, assignment gave it both stories, and the
 * roster check refused every assignment — "2 assignment(s) name a role that is not in the settled
 * roster" — because the roster held 54 agents, all kind "seam", and no implementer at all.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const LIB = join(ROOT, 'orchestrations/scripts/lib/project-roster.js')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The REAL withMintedAgents, against a project laid out the way the mint leaves one. */
function merge(opts: { canonical: Record<string, unknown>; minted: Record<string, string>; roles?: string[]; investigators?: string[] }) {
  const proj = mkdtempSync(join(tmpdir(), 'canon-mint-')); dirs.push(proj)
  writeFileSync(join(proj, 'agent-profiles.json'), JSON.stringify({ _what: 'x', profiles: opts.minted }))
  writeFileSync(join(proj, 'project-roles.json'), JSON.stringify({ _what: 'x', roles: opts.roles ?? [] }))
  writeFileSync(join(proj, 'project-investigators.json'),
    JSON.stringify({ _what: 'x', investigators: opts.investigators ?? [] }))

  const src = readFileSync(LIB, 'utf8')
  const i = src.indexOf('function withMintedAgents')
  expect(i, 'withMintedAgents is gone — canonical mode has stopped keeping the mint').toBeGreaterThan(-1)
  const body = src.slice(i, src.indexOf('\n}\n', i) + 3)
  // eslint-disable-next-line no-eval
  const fn = eval(`(function(fs, path, crypto, personaDigest, require){ ${body}; return withMintedAgents })`)(
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    require('node:fs'), require('node:path'), require('node:crypto'),
    (t: string) => require('node:crypto').createHash('sha256').update(String(t)).digest('hex'),
    (m: string) => require(m.startsWith('./') ? join(ROOT, 'orchestrations/scripts/lib', m.slice(2)) : m),
  )
  return fn({ agents: { ...opts.canonical } }, proj)
}

describe('canonical mode skips the specialiser, not the mint', () => {
  it('THE DEFECT: a minted implementer reaches the settled roster', () => {
    const r = merge({
      canonical: { 'team-lead-review': { persona: 'p', kind: 'seam' } },
      minted: { 'fare-schedule-engineer': 'implements fares' },
      roles: ['fare-schedule-engineer'],
    })
    expect(Object.keys(r.agents), 'the mint was discarded and no story could be assigned')
      .toContain('fare-schedule-engineer')
    expect(r.agents['fare-schedule-engineer'].kind).toBe('implementer')
  })

  it('minted investigators come too, with their own kind', () => {
    const r = merge({
      canonical: {},
      minted: { 'a-detective': 'reads and reports' },
      investigators: ['a-detective'],
    })
    expect(r.agents['a-detective'].kind).toBe('investigator')
  })

  it('a minted agent is its OWN ancestor — provenance is not invented', () => {
    const r = merge({ canonical: {}, minted: { eng: 'brief text' }, roles: ['eng'] })
    expect(r.agents.eng.ancestor, 'a canonical ancestor it never had would be a false claim').toBe('eng')
    expect(r.agents.eng.derivedFromSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('canonical WINS a name collision — the mint never shadows a process role', () => {
    const r = merge({
      canonical: { 'team-lead-review': { persona: 'the real one', kind: 'seam' } },
      minted: { 'team-lead-review': 'an impostor' },
      roles: ['team-lead-review'],
    })
    expect(r.agents['team-lead-review'].persona).toBe('the real one')
    expect(r.agents['team-lead-review'].kind).toBe('seam')
  })

  it('an agent in NO registry is not adopted — a kind is declared, never guessed', () => {
    const r = merge({ canonical: {}, minted: { stranger: 'unregistered' } })
    expect(Object.keys(r.agents)).not.toContain('stranger')
  })

  it('a project with no minted briefs is unchanged', () => {
    const r = merge({ canonical: { a: { persona: 'p', kind: 'seam' } }, minted: {} })
    expect(Object.keys(r.agents)).toEqual(['a'])
  })
})
