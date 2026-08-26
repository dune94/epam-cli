/**
 * A ROLE THE MINT CREATED MUST BE ASSIGNABLE TO A STORY.
 *
 * assignAgentRoles will only consider a registered role whose BRIEF exists — a role without one
 * would run with an empty system prompt. That check read the ENGINE's agents/profiles.json.
 * mergeProjectAgents deliberately stopped writing there ("every project shares it, so one
 * project's agents were reaching another's roster") and writes <project>/agent-profiles.json
 * instead, so the filter matched nothing and every mint looked like no mint at all.
 *
 * Live 2026-08-26, mock3 run 5: the mint created transit-logic-engineer, wrote its brief to the
 * project file, registered it in the project's project-roles.json — and assignment threw "no
 * project implementation roles are registered ... nothing was minted", after paying for both the
 * mint and the roster review. projectRoles() already resolved per project; only this half lagged.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The REAL candidateRoles, run against a project laid out the way the mint leaves one. */
function candidates(opts: { registered: string[]; projectBriefs: string[]; engineBriefs?: string[]; wrap?: boolean }) {
  const proj = mkdtempSync(join(tmpdir(), 'cand-proj-')); dirs.push(proj)
  const agents = mkdtempSync(join(tmpdir(), 'cand-agents-')); dirs.push(agents)
  // THE REAL SHAPE. projectRoles() reads { roles: [...] } and returns [] for a bare array —
  // a fixture that writes the wrong shape makes a working fix look broken, which is exactly
  // what it did here.
  writeFileSync(join(proj, 'project-roles.json'), JSON.stringify({ _what: 'x', roles: opts.registered }))
  const briefs = Object.fromEntries(opts.projectBriefs.map((n) => [n, 'a brief']))
  writeFileSync(join(proj, 'agent-profiles.json'),
    JSON.stringify(opts.wrap === false ? briefs : { _what: 'x', runId: 'r', profiles: briefs }))
  const engine = Object.fromEntries((opts.engineBriefs || []).map((n) => [n, 'a brief']))
  writeFileSync(join(agents, 'profiles.json'), JSON.stringify(engine))

  const src = readFileSync(RUNNER, 'utf8')
  const i = src.indexOf('function candidateRoles')
  expect(i, 'candidateRoles is gone').toBeGreaterThan(-1)
  const body = src.slice(i, src.indexOf('\n}\n', i) + 3)
  const prior = process.env.EPAM_PROJECT_CONFIG_DIR
  process.env.EPAM_PROJECT_CONFIG_DIR = proj
  try {
    // eslint-disable-next-line no-eval
    const fn = eval(`(function(fs, path, require){ ${body}; return candidateRoles })`)(
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      require('node:fs'), require('node:path'),
      (m: string) => require(m.startsWith('./lib/') ? join(ROOT, 'orchestrations/scripts', m.slice(2)) : m),
    )
    return fn(engine, agents)
  } finally {
    if (prior === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR
    else process.env.EPAM_PROJECT_CONFIG_DIR = prior
  }
}

describe('a minted role is a candidate for assignment', () => {
  it('THE DEFECT: a role whose brief is in the PROJECT file is a candidate', () => {
    expect(
      candidates({ registered: ['transit-logic-engineer'], projectBriefs: ['transit-logic-engineer'] }),
      'the mint wrote the brief and registered the role, and assignment still saw nothing',
    ).toEqual(['transit-logic-engineer'])
  })

  it('the wrapper shape and a bare map both resolve', () => {
    expect(candidates({ registered: ['r'], projectBriefs: ['r'], wrap: false })).toEqual(['r'])
  })

  it('the engine\'s own roles still resolve — epam-cli orchestrates itself', () => {
    expect(candidates({ registered: ['typescript-engineer'], projectBriefs: [], engineBriefs: ['typescript-engineer'] }))
      .toEqual(['typescript-engineer'])
  })

  it('a registered role with NO brief anywhere is still refused', () => {
    // The filter exists so a role never runs with an empty system prompt. Widening where briefs
    // are looked for must not turn it into "anything registered counts".
    expect(candidates({ registered: ['ghost'], projectBriefs: ['someone-else'] })).toEqual([])
  })
})
