/**
 * THE SEAM: ONE WRITER, MANY READERS, ONE LOCATION.
 *
 * The mint writes a project's agents to <project>/agent-profiles.json, registers their kinds in
 * <project>/project-roles.json and <project>/project-investigators.json, and the settled roster
 * lands at <project>/roster.json. Several independent consumers then read them.
 *
 * ba9cee7 (2026-08-22) moved those files out of the shared engine directory — one project's agents
 * were reaching another's roster. THREE readers were left behind, and each cost a live run:
 *
 *   candidateRoles       (spec-mode-runner)   run 5  "nothing was minted"
 *   checkRoster ancestry (project-roster)     run 7  "ancestor is not in canonical"
 *   the orphan check     (mint-agents-step)   run 8  "not in the settled roster"
 *
 * Every one is individually covered by a unit test and none of those tests could see it, because
 * the defect is not in either side — it is in the two sides disagreeing about WHERE.
 *
 * So this drives the REAL readers against a project laid out the way the mint leaves one, and asks
 * each the same question: can you see the agent that was just minted? A reader that answers no has
 * been left behind, whatever its own unit test says.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const LIB = join(ROOT, 'orchestrations/scripts/lib')
const digest = (t: string) => createHash('sha256').update(String(t)).digest('hex')

const IMPL = 'a-minted-implementer'
const INV = 'a-minted-investigator'
const BRIEF = 'a brief long enough to be real '.repeat(4)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.EPAM_PROJECT_CONFIG_DIR
})

/** A project exactly as the mint leaves one: briefs, both kind registries, the settled roster. */
function mintedProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'seam-minted-')); dirs.push(d)
  writeFileSync(join(d, 'agent-profiles.json'),
    JSON.stringify({ _what: 'x', runId: 'r', profiles: { [IMPL]: BRIEF, [INV]: BRIEF } }))
  writeFileSync(join(d, 'project-roles.json'), JSON.stringify({ _what: 'x', roles: [IMPL] }))
  writeFileSync(join(d, 'project-investigators.json'), JSON.stringify({ _what: 'x', investigators: [INV] }))
  writeFileSync(join(d, 'roster.json'), JSON.stringify({
    agents: {
      [IMPL]: { persona: BRIEF, kind: 'implementer', ancestor: IMPL, derivedFromSha256: digest(BRIEF) },
      [INV]: { persona: BRIEF, kind: 'investigator', ancestor: INV, derivedFromSha256: digest(BRIEF) },
    },
  }))
  writeFileSync(join(d, 'llm-settings.json'), JSON.stringify({}))
  process.env.EPAM_PROJECT_CONFIG_DIR = d
  return d
}

describe('every reader of a minted agent agrees with the writer', () => {
  it('the fixture is what the mint really leaves — otherwise every reader below is asked nothing', () => {
    const d = mintedProject()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { projectRosterPath } = require(join(LIB, 'project-roster.js'))
    expect(projectRosterPath(d)).toBe(join(d, 'roster.json'))
  })

  it('agent-roster: projectRoles / projectInvestigators / kindOfAgent all see it', () => {
    const d = mintedProject()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const r = require(join(LIB, 'agent-roster.js'))
    expect(r.projectRoles(d), 'the implementer is not registered where the mint put it').toContain(IMPL)
    expect(r.projectInvestigators(d)).toContain(INV)
    expect(r.kindOfAgent(IMPL, d)).toBe('implementer')
    expect(r.kindOfAgent(INV, d)).toBe('investigator')
  })

  it('project-roster: loadRoster and agentsOfKind see it', () => {
    const d = mintedProject()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pr = require(join(LIB, 'project-roster.js'))
    expect(Object.keys(pr.loadRoster(d).agents)).toContain(IMPL)
    expect(pr.agentsOfKind('implementer', d), 'the settled roster hides the minted implementer').toContain(IMPL)
  })

  it('project-roster: the contract ACCEPTS the roster the mint wrote (run 7 died here)', () => {
    const d = mintedProject()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pr = require(join(LIB, 'project-roster.js'))
    const r = pr.checkRoster(pr.loadRoster(d), {})
    expect(r.ok, `the contract refuses a freshly minted roster: ${r.reason}`).toBe(true)
  })

  it('the write perimeter permits the minted implementer and refuses the investigator', () => {
    const d = mintedProject()
    const ask = (role: string) => spawnSync('bash', ['-c',
      `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(d)}; `
      + `source ${JSON.stringify(join(LIB, 'codeline-write-perimeter.sh'))} >/dev/null 2>&1; `
      + `perimeter_role_may_write ${JSON.stringify(role)}`], { encoding: 'utf8' }).status
    expect(ask(IMPL), 'the minted implementer cannot write the code it was minted to write').toBe(0)
    expect(ask(INV), 'an investigator was granted write access').not.toBe(0)
  })

  it('spec-mode-runner: candidateRoles sees it (run 5 died here)', () => {
    const d = mintedProject()
    const out = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      const src = fs.readFileSync(${JSON.stringify(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'))}, 'utf8');
      const i = src.indexOf('function candidateRoles');
      const body = src.slice(i, src.indexOf('\\n}\\n', i) + 3);
      const req = (m) => require(m.startsWith('./lib/') ? path.join(${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}, m.slice(2)) : m);
      const fn = eval('(function(fs, path, require){ ' + body + '; return candidateRoles })')(fs, path, req);
      process.stdout.write(JSON.stringify(fn({}, ${JSON.stringify(d)})));
    `], { encoding: 'utf8', env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: d } })
    expect(out.status, out.stderr).toBe(0)
    expect(JSON.parse(out.stdout || '[]'), 'assignment has no role to choose from').toContain(IMPL)
  })

  it('mint-agents-step: the orphan check resolves the settled roster (run 8 died here)', () => {
    const d = mintedProject()
    // The check builds its role set from the settled roster. Asserted two ways: the SOURCE reads
    // projectRosterPath (not the engine profiles it used to), and that path really does contain
    // the minted agent — so neither a renamed helper nor an empty roster passes this quietly.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/mint-agents-step.js'), 'utf8')
    const i = src.indexOf('_finalRoles')
    expect(i, 'the orphan check is gone').toBeGreaterThan(-1)
    const block = src.slice(Math.max(0, i - 1400), src.indexOf('not in the settled roster', i))
    expect(block, 'the orphan check no longer resolves the settled roster')
      .toMatch(/projectRosterPath/)
    // No negative assertion on the engine-profiles read: it is retained DELIBERATELY as the
    // fallback for a project with no roster, and that behaviour has its own test. Asserting its
    // absence here would forbid the fallback.

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { projectRosterPath } = require(join(LIB, 'project-roster.js'))
    const roles = Object.keys(JSON.parse(readFileSync(projectRosterPath(d), 'utf8')).agents || {})
    expect(roles, 'a story would be refused the agent just minted for it').toContain(IMPL)
  })
})
