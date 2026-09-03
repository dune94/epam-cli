import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// THE CLAUDE STACK: plain Claude Code, on the user's own tokens.
//
// It is the mockserver set without the mock: same ladders, same budgets, same runner — the
// mockserver set was ALREADY a plain-`claude` set pointed at localhost, and its header records
// that plain `claude` honours ANTHROPIC_BASE_URL and parses the SSE it is served. Removing the
// redirect is the whole difference.
//
// codemie and openrouter stay exactly as they are. They become hot swaps by not being the
// default, and nothing about them is deleted.
const REPO = process.cwd()
const REG = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/provider-sets.json'), 'utf8'))
const PROJECTS = ['mock3', 'metrolinx', 'skyscanner', 'hello-dolly']

function settings(set: string) {
  return JSON.parse(readFileSync(join(REPO, `orchestrations/config/llm-defaults.${set}.json`), 'utf8'))
}

describe('the claude set is the default stack', () => {
  it('the set is declared and is the default', () => {
    expect(REG.sets.claude, 'no claude set declared').toBeTruthy()
    expect(REG.defaultSet).toBe('claude')
  })

  it('the hot swaps survive — nothing was deleted to make room', () => {
    expect(REG.sets.codemie, 'codemie must remain as hot swap 1').toBeTruthy()
    expect(REG.sets.openrouter, 'openrouter must remain as hot swap 2').toBeTruthy()
    expect(REG.sets.mockserver, 'mockserver must remain for free rehearsal').toBeTruthy()
  })

  it('it runs plain claude and reaches NO mock', () => {
    const s = settings('claude')
    expect(Object.keys(s.runners)).toEqual(['claude'])
    const env = s.runners.claude.env || {}
    expect(env.ANTHROPIC_BASE_URL, 'a real stack must not redirect to a mock').toBeUndefined()
    expect(s.mockBaseUrl, 'the mock base url has no place in a paid stack').toBeUndefined()
  })

  it('LADDER, RETRY, SELF-HEAL: it declares the full ladder set, same shape as the others', () => {
    const s = settings('claude')
    const m = settings('mockserver')
    expect(Object.keys(s.ladders).sort()).toEqual(Object.keys(m.ladders).sort())
    for (const [tier, def] of Object.entries(s.ladders) as any) {
      expect(String(def.startModel || ''), `${tier} has no start model`).not.toBe('')
      expect(Array.isArray(def.rungs) && def.rungs.length, `${tier} declares no rungs`).toBeTruthy()
    }
    expect(s.finalFallback && s.finalFallback.model, 'no final fallback after ladder exhaustion').toBeTruthy()
    expect(s.finalFallback.provider).toBe('claude')
  })

  it('every project has the overlay, and it names the claude provider', () => {
    for (const p of PROJECTS) {
      const f = join(REPO, `orchestrations/projects/${p}/config.claude.env`)
      expect(existsSync(f), `${p} has no config.claude.env`).toBe(true)
      const body = readFileSync(f, 'utf8')
      expect(body, `${p} overlay does not set the orchestration provider`)
        .toMatch(/^EPAM_ORCHESTRATION_PROVIDER=claude$/m)
      expect(body, `${p} overlay must not name the codemie wrapper`).not.toMatch(/codemie-claude/)
    }
  })

  it('a paid stack is NOT treated as a free run', () => {
    // the seal is opt-in via EPAM_FREE_RUN; nothing may infer freeness from the runner name
    const src = readFileSync(join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8')
    expect(src).not.toMatch(/runners\.every/)
  })
})
