import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// HOW LONG A LOCAL TOOL MAY TAKE IS DECLARED.
//
// Thirteen subprocess timeouts were written as literals across seven libraries — 5000, 10000,
// 15000, 20000, 30000, 60000, 180000 — each an independent decision with no single home. A
// codeline big enough to need longer got a truncated answer from whichever tool hit its cap
// first, and the caller could not tell a timeout from an empty result. Raising one meant
// finding all of them.
const REPO = process.cwd()
const CFG = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/tool-timeouts.json'), 'utf8'))
const { toolTimeoutMs } = require(join(REPO, 'orchestrations/scripts/lib/tool-timeouts.js'))

function literals(): string[] {
  try {
    const out = execFileSync('grep', ['-rnE', 'timeout:\\s*[0-9]+',
      'orchestrations/scripts', '--include=*.js'], { cwd: REPO, encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean).filter(l => {
      const body = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1).trim()
      return !(body.startsWith('//') || body.startsWith('*'))
    })
  } catch (e: any) {
    if (e.status === 1) return []
    throw e
  }
}

describe('a tool timeout is declared', () => {
  it('the declaration exists and every entry is a positive number of ms', () => {
    const t = CFG.tools
    expect(t && Object.keys(t).length, 'no tools declared').toBeGreaterThan(0)
    for (const [k, v] of Object.entries(t) as any) {
      if (k.startsWith('$')) continue
      expect(Number.isFinite(v), `tools.${k} must be a number`).toBe(true)
      expect(v, `tools.${k} must be positive`).toBeGreaterThan(0)
    }
  })

  it('THE INVARIANT: no engine library writes a subprocess timeout as a literal', () => {
    expect(literals(),
      'these are independent decisions with no single home. Declare them in '
      + 'config/tool-timeouts.json and read with toolTimeoutMs(name).').toEqual([])
  })

  it('EXECUTED: the reader returns the declared value', () => {
    for (const k of Object.keys(CFG.tools).filter(k => !k.startsWith('$'))) {
      expect(toolTimeoutMs(k), `${k} did not resolve to its declaration`).toBe(CFG.tools[k])
    }
  })

  it('an undeclared name REFUSES rather than inventing a cap', () => {
    // Returning a default would put the decision back in code, where it just came from.
    expect(() => toolTimeoutMs('no-such-tool')).toThrow(/no-such-tool/)
  })
})
