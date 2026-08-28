import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE OPERATOR DECLARES A FREE RUN. THE ENGINE DOES NOT GUESS.
//
// The free-run seal used to decide this by inspecting runner NAMES —
// `runners.every(r => r === 'claude')` — so the engine carried mock-specific reasoning in its
// normal path, and the comment above it claimed it read a declaration when it did not. Two
// consequences: a real plain-`claude` stack would have been classified as free and had its
// credentials scrubbed mid-run, and the mock governed how a paid run behaved.
//
// Now it is one environment variable, set by whoever launches a free run. A normal run never
// sets it, so the seal never fires and nothing about mocks reaches the engine.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib/free-run-guard.sh')

function askGuard(env: Record<string, string>) {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; free_run_requested && echo FREE_RUN || echo SPENDS`],
    { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as any })
  return (r.stdout || '').trim()
}

describe('the operator declares a free run', () => {
  it('EPAM_FREE_RUN=1 seals the run', () => {
    expect(askGuard({ EPAM_FREE_RUN: '1' })).toBe('FREE_RUN')
  })

  it('the usual truthy spellings are honoured', () => {
    for (const v of ['true', 'TRUE', 'yes', 'Yes']) {
      expect(askGuard({ EPAM_FREE_RUN: v }), `EPAM_FREE_RUN=${v}`).toBe('FREE_RUN')
    }
  })

  it('THE REGRESSION: unset means SPENDS — no inference from any provider or runner name', () => {
    // This is the case that would have scrubbed a real Claude stack's credentials mid-run,
    // because its runner happened to be named `claude`.
    expect(askGuard({ EPAM_PROVIDER_SET: 'claude' })).toBe('SPENDS')
    expect(askGuard({ EPAM_PROVIDER_SET: 'mockserver' })).toBe('SPENDS')
  })

  it('an explicit off value SPENDS', () => {
    for (const v of ['0', 'false', 'no', '']) {
      expect(askGuard({ EPAM_FREE_RUN: v }), `EPAM_FREE_RUN=${v}`).toBe('SPENDS')
    }
  })

  it('the launcher names no runner and no vendor when deciding this', () => {
    const src = readFileSync(join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8')
    const i = src.indexOf('free-run-guard.sh')
    const block = src.slice(Math.max(0, i - 500), i + 2000)
    expect(block, 'the launcher still infers freeness from a runner name')
      .not.toMatch(/runners\.every|=== *"claude"/)
  })
})
