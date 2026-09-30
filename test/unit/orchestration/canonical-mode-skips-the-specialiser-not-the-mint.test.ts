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
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require(LIB)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamForKind } = require(join(ROOT, 'orchestrations/scripts/lib/seam-invocation.js'))
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The REAL withMintedAgents, against a project laid out the way the mint leaves one. */
function merge(opts: { canonical: Record<string, unknown>; minted: Record<string, string>; roles?: string[]; investigators?: string[] }) {
  const proj = mkdtempSync(join(tmpdir(), 'canon-mint-')); dirs.push(proj)
  writeFileSync(join(proj, 'agent-profiles.json'), JSON.stringify({ _what: 'x', profiles: opts.minted }))
  writeFileSync(join(proj, 'project-roles.json'), JSON.stringify({ _what: 'x', roles: opts.roles ?? [] }))
  writeFileSync(join(proj, 'project-investigators.json'),
    JSON.stringify({ _what: 'x', investigators: opts.investigators ?? [] }))

  // THE REAL exported function, and the REAL base beneath the entries the case names (operator,
  // 2026-09-29: base and derived SIs are matched to each seam, so a minted agent derives from its
  // seam's base, which must be present). Lifting the body out of the source text tested a copy.
  const prev = process.env.EPAM_PROJECT_CONFIG_DIR
  process.env.EPAM_PROJECT_CONFIG_DIR = proj
  try {
    const base = JSON.parse(readFileSync(lib.seamBaseForRun(REGISTRY, proj), 'utf8'))
    const agents: Record<string, unknown> = {}
    for (const [s, text] of Object.entries(base)) agents[s] = { persona: text, kind: 'seam', ancestor: s, derivedFromSha256: lib.personaDigest(text) }
    return lib.withMintedAgents({ agents: { ...agents, ...opts.canonical } }, proj)
  } finally {
    if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR
    else process.env.EPAM_PROJECT_CONFIG_DIR = prev
  }
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

  it('a minted agent derives from ITS SEAM — never from itself', () => {
    const r = merge({ canonical: {}, minted: { eng: 'brief text' }, roles: ['eng'] })
    const seam = seamForKind('implementer', REGISTRY)
    expect(r.agents.eng.ancestor, 'a minted agent must name the seam it is an instance of').toBe(seam)
    expect(r.agents.eng.derivedFromSha256).toBe(lib.personaDigest(r.agents[seam].persona))
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
    const kinds = Object.values(r.agents).map((e: any) => e.kind)
    expect(kinds.filter((k) => k !== 'seam'), 'no minted agent may appear from nowhere').toEqual([])
  })
})
