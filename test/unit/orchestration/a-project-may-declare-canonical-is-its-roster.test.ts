import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A PROJECT MAY DECLARE THAT CANONICAL IS ITS ROSTER.
//
// roster-specialiser is the most expensive seam in a run: top ladder, sonnet, 65536 output
// tokens, up to 250 turns. A rehearsal project does not need specialised personas, and paying
// for them to rehearse plumbing is paying for the wrong thing.
//
// This is NOT the behaviour 862ca17 removed. That commit stopped EPAM_SKIP_AGENT_MINT from
// silently ALSO skipping roster derivation, because skipping it meant "run with no identities".
// Here identities are installed explicitly — canonical, verbatim, complete — there is simply no
// agent call. Declared per project, so the default stays: derive, review, regenerate every run.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib/project-roster.js')
const { buildProjectRoster } = require(LIB)

function harness(rosterMode?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-roster-'))
  const logDir = join(dir, 'logs'); mkdirSync(logDir, { recursive: true })
  const projectDir = join(dir, 'project'); mkdirSync(projectDir, { recursive: true })
  const canonicalPath = join(dir, 'profiles.canonical.json')
  writeFileSync(canonicalPath, JSON.stringify({
    'alpha-agent': 'You are the alpha agent and you do alpha things thoroughly.',
    'beta-agent': 'You are the beta agent and you do beta things thoroughly.',
  }, null, 2))
  if (rosterMode) {
    writeFileSync(join(projectDir, 'llm-settings.json'), JSON.stringify({ rosterMode }, null, 2))
  }
  return { dir, logDir, projectDir, canonicalPath }
}

describe('a project may declare that canonical is its roster', () => {
  it('rosterMode canonical: NO agent is called, and the roster is canonical verbatim', async () => {
    const { dir, logDir, projectDir, canonicalPath } = harness('canonical')
    let produceCalls = 0
    let reviewCalls = 0
    const roster = await buildProjectRoster({
      canonicalPath, logDir, projectConfigDir: projectDir,
      produce: async () => { produceCalls += 1 },
      review: async () => { reviewCalls += 1; return { verdict: 'approved' } },
      attempts: 3, log: () => {},
    })
    rmSync(dir, { recursive: true, force: true })

    expect(produceCalls, 'the specialiser was called — that is the spend this mode exists to avoid').toBe(0)
    expect(reviewCalls, 'the reviewer was called — nothing was generated to review').toBe(0)
    // IDENTITIES MUST EXIST. This is the invariant 862ca17 protects: skipping generation must
    // never mean running with no roster.
    expect(Object.keys(roster.agents).sort()).toEqual(['alpha-agent', 'beta-agent'])
    // verbatim: the persona text is canonical's, unchanged, with provenance recorded
    expect(roster.agents['alpha-agent'].persona).toContain('alpha things')
    expect(roster.agents['alpha-agent'].ancestor).toBe('alpha-agent')
    expect(String(roster.agents['alpha-agent'].derivedFromSha256 || '')).not.toBe('')
  })

  it('the default is UNCHANGED: with no declaration, the specialiser still runs', async () => {
    const { dir, logDir, projectDir, canonicalPath } = harness()
    let produceCalls = 0
    await buildProjectRoster({
      canonicalPath, logDir, projectConfigDir: projectDir,
      produce: async ({ outPath }: any) => {
        produceCalls += 1
        // the shape the contract requires: persona, kind, ancestor and provenance digest
        const { personaDigest } = require(LIB)
        const canon = JSON.parse(readFileSync(canonicalPath, 'utf8'))
        const entry = (name: string, text: string) => ({
          persona: text, kind: 'seam', ancestor: name,
          derivedFromSha256: personaDigest(canon[name]),
        })
        writeFileSync(outPath, JSON.stringify({ agents: {
          'alpha-agent': entry('alpha-agent', 'Specialised alpha persona for this project, at length.'),
          'beta-agent': entry('beta-agent', 'Specialised beta persona for this project, at length.'),
        } }, null, 2))
      },
      review: async () => ({ verdict: 'approved' }),
      attempts: 3, log: () => {},
    })
    rmSync(dir, { recursive: true, force: true })
    expect(produceCalls, 'the default must still derive a project roster').toBe(1)
  })

  it('an unknown rosterMode is REFUSED, not silently treated as the default', async () => {
    const { dir, logDir, projectDir, canonicalPath } = harness('sometimes-maybe')
    let threw: Error | null = null
    try {
      await buildProjectRoster({
        canonicalPath, logDir, projectConfigDir: projectDir,
        produce: async () => {}, review: async () => ({ verdict: 'approved' }),
        attempts: 1, log: () => {},
      })
    } catch (e: any) { threw = e }
    rmSync(dir, { recursive: true, force: true })
    expect(threw, 'a typo in rosterMode would quietly cost a full specialisation').toBeTruthy()
    expect(String(threw?.message)).toMatch(/rosterMode/i)
  })
})
