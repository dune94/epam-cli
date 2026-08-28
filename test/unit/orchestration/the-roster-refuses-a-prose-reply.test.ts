import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THE OUTPUT CONTRACT, DRIVEN BY A REAL REPLY.
//
// The roster stage has tests for its prompt layer, its refusal text, its budget and its
// wiring — and none that hand it an answer a model actually gave and check it is refused.
// Wiring tests cannot see a contract failure: they prove the call happens, not that a bad
// answer is rejected.
//
// The reply here is NOT invented. It is the roster-specialiser's real output, recovered from
// a paid run via Langfuse: the model narrated instead of answering — "I need to create a
// valid JSON file. Let me fix the formatting:" — and that prose is what reached the contract.
// A fabricated fixture would only confirm what I assumed the model does wrong.
const REPO = process.cwd()
const { buildProjectRoster, canonicalCopyPath, copyCanonicalForRun } =
  require(join(REPO, 'orchestrations/scripts/lib/project-roster.js'))

// Discover the recovered capture rather than naming one: cassette directories are stamped
// per run, and a test that names one dies the next time a run is recorded.
function realProseReply(): string | null {
  const root = join(REPO, 'orchestrations/cassettes')
  if (!existsSync(root)) return null
  for (const d of readdirSync(root).sort().reverse()) {
    const f = join(root, d, 'roster-specialiser.json')
    if (!existsSync(f)) continue
    try {
      const turns = Object.values(JSON.parse(readFileSync(f, 'utf8'))) as any[]
      const texts = turns.map(t => t && t.text).filter(t => t && String(t).trim())
      const last = texts[texts.length - 1]
      // only interested in a capture whose final answer is NOT the JSON the contract wants
      if (last && !/^\s*[[{]/.test(String(last))) return String(last)
    } catch { /* an unreadable capture is not a reply */ }
  }
  return null
}

const PROSE = realProseReply()

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'roster-contract-'))
  const logDir = join(dir, 'logs'); mkdirSync(logDir, { recursive: true })
  const projectDir = join(dir, 'project'); mkdirSync(projectDir, { recursive: true })
  const canonicalPath = join(dir, 'profiles.canonical.json')
  writeFileSync(canonicalPath, JSON.stringify({
    'alpha-agent': 'You are the alpha agent.',
    'beta-agent': 'You are the beta agent.',
  }, null, 2))
  return { dir, logDir, projectDir, canonicalPath }
}

describe('the roster refuses a reply that is not the artefact', () => {
  it.skipIf(!PROSE)('a real prose reply is REFUSED, never accepted as a roster', async () => {
    const { dir, logDir, projectDir, canonicalPath } = harness()
    const lines: string[] = []
    let attempts = 0

    // The producer writes exactly what the model really wrote.
    const produce = async ({ outPath }: any) => { attempts += 1; writeFileSync(outPath, PROSE as string) }

    let threw: Error | null = null
    let result: any = null
    try {
      result = await buildProjectRoster({
        canonicalPath, logDir, projectConfigDir: projectDir,
        produce, review: async () => ({ verdict: 'approved' }),
        attempts: 3, log: (m: string) => lines.push(m),
      })
    } catch (e: any) { threw = e }
    rmSync(dir, { recursive: true, force: true })

    // The contract must REFUSE. Accepting prose would put narration where every downstream
    // agent reads its identity.
    const accepted = !threw && result && result.agents
    expect(accepted, 'prose was accepted as a roster').toBeFalsy()

    // And it must spend its declared attempts rather than dying on the first.
    expect(attempts, 'the stage must use its declared attempts, not die on the first').toBe(3)

    // The refusal must say WHY — "it failed" is not a diagnosis anyone can act on.
    const said = lines.join('\n')
    expect(said).toMatch(/REFUSED|not valid JSON/i)
  })

  it('the harness found a real capture to drive this — otherwise it proves nothing', () => {
    // Fails loudly rather than skipping silently: a green suite with no capture would read as
    // "the contract is covered" when nothing exercised it.
    expect(PROSE, 'no recovered roster-specialiser capture with a non-JSON reply was found under '
      + 'orchestrations/cassettes — this test cannot run on an invented fixture').toBeTruthy()
  })
})
