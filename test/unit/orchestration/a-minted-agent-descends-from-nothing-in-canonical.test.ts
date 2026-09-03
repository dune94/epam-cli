/**
 * A MINTED AGENT'S HONEST PROVENANCE IS ITSELF, AND THE CONTRACT SAYS SO.
 *
 * checkRoster requires every ancestor to name an entry in canonical — that is how a DERIVED agent
 * inherits a ladder, a tool grant and an output contract. A minted agent has no such ancestor: it
 * is a role this project needed and canonical never had.
 *
 * That used to pass by accident. Until 2026-08-22 (ba9cee7) the mint wrote into the engine's
 * profiles.json, so minted agents WERE in the canonical copy. Isolating that file — one project's
 * agents were reaching another's roster — removed the accident and nothing replaced it, so every
 * minted agent became a contract violation. mock3 run 7 died on it: "ancestor
 * 'fare-rules-engineer' is not in canonical".
 *
 * Stated as an exemption rather than bypassed by adding these agents after the check: a contract
 * that says every agent needs a canonical ancestor while some quietly do not is a contract nobody
 * can rely on. REGISTRATION earns it, so this cannot widen into "anything may skip the check".
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkRoster } = require(join(__dirname, '../../../orchestrations/scripts/lib/project-roster.js'))

const digest = (t: string) => createHash('sha256').update(String(t)).digest('hex')
const CANON = { 'team-lead-review': 'a canonical persona' }
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.EPAM_PROJECT_CONFIG_DIR
})

/** A project dir with the kind registries the mint writes. */
function project(opts: { roles?: string[]; investigators?: string[] }) {
  const d = mkdtempSync(join(tmpdir(), 'minted-prov-')); dirs.push(d)
  writeFileSync(join(d, 'project-roles.json'), JSON.stringify({ _what: 'x', roles: opts.roles ?? [] }))
  writeFileSync(join(d, 'project-investigators.json'),
    JSON.stringify({ _what: 'x', investigators: opts.investigators ?? [] }))
  process.env.EPAM_PROJECT_CONFIG_DIR = d
  return d
}

const canonicalEntry = {
  persona: CANON['team-lead-review'], kind: 'seam',
  ancestor: 'team-lead-review', derivedFromSha256: digest(CANON['team-lead-review']),
}

describe('a minted agent descends from nothing in canonical', () => {
  it('THE DEFECT: a REGISTERED minted agent with self-ancestry satisfies the contract', () => {
    project({ roles: ['fare-schedule-engineer'] })
    const r = checkRoster({ agents: {
      'team-lead-review': canonicalEntry,
      'fare-schedule-engineer': {
        persona: 'implements fares', kind: 'implementer',
        ancestor: 'fare-schedule-engineer', derivedFromSha256: digest('implements fares'),
      },
    } }, CANON)
    expect(r.ok, `the contract still refuses a minted agent: ${r.reason}`).toBe(true)
  })

  it('a registered INVESTIGATOR is exempt on the same terms', () => {
    project({ investigators: ['a-detective'] })
    const r = checkRoster({ agents: {
      'team-lead-review': canonicalEntry,
      'a-detective': {
        persona: 'reads and reports', kind: 'investigator',
        ancestor: 'a-detective', derivedFromSha256: digest('reads and reports'),
      },
    } }, CANON)
    expect(r.ok, r.reason).toBe(true)
  })

  it('THE LIMIT: self-ancestry WITHOUT registration is still refused', () => {
    // Otherwise the exemption becomes "any agent may claim to be its own ancestor", which is the
    // check deleted rather than narrowed.
    project({ roles: [] })
    const r = checkRoster({ agents: {
      'team-lead-review': canonicalEntry,
      stranger: { persona: 'x', kind: 'implementer', ancestor: 'stranger', derivedFromSha256: digest('x') },
    } }, CANON)
    expect(r.ok, 'an unregistered agent was allowed to vouch for itself').toBe(false)
    expect(String(r.reason)).toMatch(/stranger/)
  })

  it('a minted agent\'s digest must still match its OWN brief', () => {
    // Self-ancestry moves what the digest is over; it does not make provenance optional.
    project({ roles: ['eng'] })
    const r = checkRoster({ agents: {
      'team-lead-review': canonicalEntry,
      eng: { persona: 'the real brief', kind: 'implementer', ancestor: 'eng', derivedFromSha256: digest('a different brief') },
    } }, CANON)
    expect(r.ok, 'a stale digest passed unnoticed on a minted agent').toBe(false)
  })

  it('a DERIVED agent is unaffected — a bad canonical ancestor is still refused', () => {
    project({ roles: ['eng'] })
    const r = checkRoster({ agents: {
      'team-lead-review': canonicalEntry,
      eng: { persona: 'p', kind: 'implementer', ancestor: 'no-such-canonical-role', derivedFromSha256: digest('p') },
    } }, CANON)
    expect(r.ok).toBe(false)
    expect(String(r.reason)).toMatch(/no-such-canonical-role/)
  })
})
