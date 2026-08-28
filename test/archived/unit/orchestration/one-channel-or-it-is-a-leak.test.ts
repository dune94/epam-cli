import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ONE CHANNEL. Every LLM call resolves its vendor, model, base URL and credential in one
// place and is issued from one place: llm-handler.sh, which dispatches to vendor handlers.
//
// This is a RATCHET, not a pass/fail on the whole tree. Eight independent channels existed on
// 2026-08-25 — each read its own credential and called its own endpoint — and a run labelled
// `mockserver` billed a real API for 34 minutes because the free-run seal held at some of them
// and not others. The declared list may only SHRINK. A new file reading a vendor credential,
// or naming a vendor endpoint, fails here on the day it is written rather than on the day it
// spends money.
//
// The patterns and the list are DECLARED in config/llm-channel.json: which module is the
// gateway, and how far the migration has got, are facts about this deployment — not about how
// to detect a channel.
const REPO = process.cwd()
const CFG = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/llm-channel.json'), 'utf8'))

function scan(pattern: string): string[] {
  const args = ['-rlE', pattern, ...CFG.scanRoots,
    '--include=*.sh', '--include=*.js', '--include=*.ts', '--include=*.py']
  let out = ''
  try {
    out = execFileSync('grep', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  } catch (e: any) {
    // grep exits 1 when nothing matches — that is a clean result, not an error
    if (e.status === 1) return []
    throw e
  }
  const exclude = new RegExp(CFG.excludePattern)
  return out.trim().split('\n').filter(Boolean)
    .filter(f => !exclude.test(f))
    .filter(f => f !== CFG.gateway)
    .sort()
}

describe('one channel, or it is a leak', () => {
  it('the declared gateway exists', () => {
    expect(() => readFileSync(join(REPO, CFG.gateway), 'utf8')).not.toThrow()
  })

  it('no UNDECLARED file reads a vendor credential', () => {
    const found = scan(CFG.credentialPattern)
    const undeclared = found.filter(f => !CFG.unmigrated.includes(f))
    expect(undeclared,
      'these read an LLM credential but are not declared in llm-channel.json. Route the call '
      + 'through llm-handler.sh, or add the file to `unmigrated` with a reason.').toEqual([])
  })

  it('no UNDECLARED file names a vendor endpoint', () => {
    const found = scan(CFG.endpointPattern)
    const undeclared = found.filter(f => !CFG.unmigrated.includes(f))
    expect(undeclared,
      'these name a vendor endpoint directly. The endpoint belongs to the provider set, not '
      + 'to engine code.').toEqual([])
  })

  it('THE RATCHET: the unmigrated list only shrinks', () => {
    // Guard against a vacuous pass: if the scan finds nothing at all the harness is broken,
    // because the list below is non-empty and those files genuinely still match.
    const all = new Set([...scan(CFG.credentialPattern), ...scan(CFG.endpointPattern)])
    expect(all.size, 'the scanner matched nothing — every assertion here would be vacuous')
      .toBeGreaterThan(0)

    const stale = CFG.unmigrated.filter((f: string) => !all.has(f))
    expect(stale,
      'these are listed as unmigrated but no longer match — remove them from `unmigrated`, '
      + 'the list is a ratchet and must not carry entries that are already clean.').toEqual([])
  })
})
