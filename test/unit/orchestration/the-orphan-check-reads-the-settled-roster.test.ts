/**
 * "NOT IN THE SETTLED ROSTER" MUST BE CHECKED AGAINST THE SETTLED ROSTER.
 *
 * The last deterministic gate of the mint step rejects any assignment naming a role that does not
 * exist, so a lane never invokes an agent with no brief. It read the ENGINE's agents/profiles.json.
 *
 * ba9cee7 (2026-08-22) stopped the mint writing there — one project's agents were reaching
 * another's roster — moving briefs to <project>/agent-profiles.json and the settled roster to
 * <project>/roster.json. This reader was left behind, so it checked assignments against a file the
 * mint no longer touches and rejected every project role.
 *
 * mock3 run 8: the roster held fare-schedule-logic-engineer as an implementer, project-roles.json
 * registered it, agent-profiles.json carried its brief — and the gate threw "names a role that is
 * not in the settled roster" for the one agent the run had just minted. Second reader left behind
 * by that move; candidateRoles in spec-mode-runner was the first.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const STEP = join(ROOT, 'orchestrations/scripts/mint-agents-step.js')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.EPAM_PROJECT_CONFIG_DIR
})

/** The REAL resolution block, lifted and run against a project on disk. */
function orphans(opts: { rosterAgents?: string[] | null; engineProfiles: string[]; assigned: string[] }) {
  const proj = mkdtempSync(join(tmpdir(), 'orphan-')); dirs.push(proj)
  if (opts.rosterAgents) {
    writeFileSync(join(proj, 'roster.json'), JSON.stringify({
      agents: Object.fromEntries(opts.rosterAgents.map((n) => [n, { persona: 'p', kind: 'implementer' }])),
    }))
  }
  const engine = join(proj, 'profiles.json')
  writeFileSync(engine, JSON.stringify(Object.fromEntries(opts.engineProfiles.map((n) => [n, 'brief']))))
  process.env.EPAM_PROJECT_CONFIG_DIR = proj

  const src = readFileSync(STEP, 'utf8')
  const i = src.indexOf('// THE SETTLED ROSTER IS roster.json')
  expect(i, 'the settled-roster resolution is gone').toBeGreaterThan(-1)
  const end = src.indexOf('\n', src.indexOf('_finalRoles = new Set(Object.keys(JSON.parse(fs.readFileSync(PROFILES_PATH', i))
  const block = src.slice(i, src.indexOf('}', end) + 1)

  // eslint-disable-next-line no-eval
  const finalRoles = eval(`(function(fs, PROFILES_PATH, require){ ${block}; return _finalRoles })`)(
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    require('node:fs'), engine,
    (m: string) => require(m.startsWith('./lib/') ? join(ROOT, 'orchestrations/scripts', m.slice(2)) : m),
  )
  return opts.assigned.filter((r) => !finalRoles.has(r))
}

describe('the orphan check reads the settled roster', () => {
  it('THE DEFECT: a minted role in the roster is accepted, though absent from engine profiles', () => {
    expect(
      orphans({
        rosterAgents: ['team-lead-review', 'fare-schedule-logic-engineer'],
        engineProfiles: ['team-lead-review'],
        assigned: ['fare-schedule-logic-engineer'],
      }),
      'the run\'s own minted agent was rejected as not existing',
    ).toEqual([])
  })

  it('a role in NEITHER is still orphaned — the gate is narrowed, not removed', () => {
    expect(orphans({
      rosterAgents: ['team-lead-review'],
      engineProfiles: ['team-lead-review'],
      assigned: ['ghost'],
    })).toEqual(['ghost'])
  })

  it('with no project roster it falls back to engine profiles, unchanged', () => {
    expect(orphans({ rosterAgents: null, engineProfiles: ['typescript-engineer'], assigned: ['typescript-engineer'] }))
      .toEqual([])
    expect(orphans({ rosterAgents: null, engineProfiles: ['typescript-engineer'], assigned: ['ghost'] }))
      .toEqual(['ghost'])
  })
})
