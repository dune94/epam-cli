/**
 * SEAM MATRIX: EVERY DECLARED SEAM, EVERY LINK OF ITS CHAIN.
 *
 * A seam is only invocable if the whole chain resolves: a model that is a real rung of a declared
 * ladder, a prompt template that exists, an output-token budget, a tool grant, and a seam name the
 * runner can attribute the call to. Each link is owned by a different file, and every link that
 * broke this month broke SILENTLY — the value was absent, not wrong:
 *
 *   no model            "repro-test-writer REFUSED to run: no model resolved for this seam"
 *   no output contract  five seams asked Claude for JSON and never told it so
 *   no tool grant       topology-router inherited whatever the previous agent held
 *   no budget           per-model iteration budgets reached no seam on any stack
 *
 * Derived from the registry, so a seam added tomorrow is checked tomorrow, and driven through the
 * REAL resolvers with the ladder exported the way a run exports it.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const SCRIPTS = join(ROOT, 'orchestrations/scripts')
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates')
const PROJECT = join(ROOT, 'orchestrations/projects/mock3')
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node')
const REG = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'))

const SEAMS = Object.keys(REG.profiles || {}).filter((k) => !k.startsWith('$') && !k.startsWith('_') && k !== 'defaults')

/** Every seam's resolved env, produced once through the REAL resolvers with a real ladder. */
let RESOLVED: Record<string, Record<string, string>> = {}
beforeAll(() => {
  const out = spawnSync('bash', ['-c',
    `. ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))}; `
    + `export_model_ladders ${JSON.stringify(join(PROJECT, 'llm-settings.json'))} >/dev/null 2>&1; `
    + `"$NODE_BIN" -e '
        const { seamInvocationEnv } = require("${join(SCRIPTS, 'lib/seam-invocation.js')}");
        const names = JSON.parse(process.argv[1]);
        const out = {};
        for (const n of names) { try { out[n] = seamInvocationEnv(n) || {}; } catch (e) { out[n] = { _error: String(e.message).slice(0,120) }; } }
        process.stdout.write(JSON.stringify(out));
      ' ${JSON.stringify(JSON.stringify(SEAMS))}`],
  { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'claude', EPAM_PROJECT_CONFIG_DIR: PROJECT, NODE_BIN } })
  RESOLVED = JSON.parse(out.stdout || '{}')
}, 60_000)

/** Every model any declared ladder can reach, on the stack under test. */
function ladderRungs(): Set<string> {
  const j = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/llm-defaults.claude.json'), 'utf8'))
  const s = new Set<string>()
  for (const tier of Object.values<any>(j.ladders || {})) {
    if (tier.startModel) s.add(tier.startModel)
    for (const hop of tier.modelLadder || []) { s.add(hop.from); s.add(hop.to) }
  }
  return s
}

describe('seam matrix: every declared seam resolves its whole chain', () => {
  it('there are seams to check, and they resolved — otherwise every row below is vacuous', () => {
    expect(SEAMS.length, 'the registry declares no seams').toBeGreaterThan(20)
    expect(Object.keys(RESOLVED).length, 'resolution produced nothing at all').toBe(SEAMS.length)
    const errored = SEAMS.filter((s) => RESOLVED[s] && RESOLVED[s]._error)
    expect(errored, `resolution threw for: ${errored.map((s) => `${s} (${RESOLVED[s]._error})`).join('; ')}`).toEqual([])
  })

  it('every seam resolves a model', () => {
    const bad = SEAMS.filter((s) => !RESOLVED[s]?.EPAM_MODEL)
    expect(bad, `these would refuse to run: ${bad.join(', ')}`).toEqual([])
  })

  it('every resolved model is a real rung of a declared ladder', () => {
    // A model nothing declares cannot be escalated from, and is unpriceable.
    const rungs = ladderRungs()
    const bad = SEAMS.filter((s) => { const m = RESOLVED[s]?.EPAM_MODEL; return m && !rungs.has(m) })
      .map((s) => `${s} -> ${RESOLVED[s].EPAM_MODEL}`)
    expect(bad, `resolved to a model no ladder declares: ${bad.join(', ')}`).toEqual([])
  })

  it('every seam has a prompt template on disk', () => {
    const bad = SEAMS.filter((s) => {
      const t = (REG.profiles[s] && REG.profiles[s].template) || s
      return !existsSync(join(TEMPLATES, `${t}.json`))
    })
    expect(bad, `declare a template that exists nowhere: ${bad.join(', ')}`).toEqual([])
  })

  it('every seam gets an output-token budget', () => {
    const bad = SEAMS.filter((s) => !RESOLVED[s]?.EPAM_MAX_OUTPUT_TOKENS)
    expect(bad, `no output budget, so the default decides: ${bad.join(', ')}`).toEqual([])
  })

  it('every seam gets a tool grant decision — even an explicit none', () => {
    // An absent grant is inherited from whatever ran last; topology-router did exactly that.
    const bad = SEAMS.filter((s) => RESOLVED[s]?.EPAM_ALLOWED_TOOLS === undefined)
    expect(bad, `would inherit the previous agent's tools: ${bad.join(', ')}`).toEqual([])
  })

  it('every seam names itself, so a call can be attributed and costed', () => {
    const bad = SEAMS.filter((s) => !RESOLVED[s]?.EPAM_SEAM)
    expect(bad, `unattributable in the cost ledger and in Langfuse: ${bad.join(', ')}`).toEqual([])
  })

  it('every seam that declares what it PRODUCES is one a consumer can parse', () => {
    // produces + a template that states no shape is the "asked Claude for JSON and never told it"
    // defect. Only checked where the seam declares an output at all.
    const bad: string[] = []
    for (const s of SEAMS) {
      const p = REG.profiles[s]
      if (!p || !p.produces) continue
      const t = (p.template || s)
      const body = readFileSync(join(TEMPLATES, `${t}.json`), 'utf8')
      const statesShape = /<[A-Z][A-Z0-9_]+>|"[a-zA-Z][a-zA-Z0-9_]*"\s*:/.test(body)
      if (!statesShape) bad.push(`${s} produces "${p.produces}" and its template states no shape`)
    }
    expect(bad, bad.join('; ')).toEqual([])
  })
})
