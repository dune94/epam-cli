import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE AUDIT COUNTS CODE. A DECLARATION IS NOT HARDCODING.
//
// The scanner swept orchestrations/config and orchestrations/agents JSON on the argument that a
// shipped default is "an engine fact". That made the headline number meaningless: 205 of 658
// sites were llm-defaults.*.json naming the models it exists to name, and profiles.json holding
// the personas it exists to hold. Deleting those breaks the stacks — they are the configuration
// the engine reads, which is the OPPOSITE of a value baked into code.
//
// Operator decision, 2026-08-26: json and config are not hardcoding.
const REPO = process.cwd()
const AUDIT = join(REPO, 'orchestrations/scripts/hardcoding-audit.sh')

function verify(cat: number): string[] {
  const out = execFileSync('bash', [AUDIT, '--verify', String(cat)], { cwd: REPO, encoding: 'utf8' })
  return out.trim().split('\n').filter(l => /^(orchestrations|src)\//.test(l))
}

describe('the audit counts code, not declarations', () => {
  it('the scanned scope is DECLARED, not written into the scanner', () => {
    const cfg = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/hardcoding-audit-scope.json'), 'utf8'))
    expect(Array.isArray(cfg.scan) && cfg.scan.length, 'no scan roots declared').toBeTruthy()
    expect(Array.isArray(cfg.excludePatterns), 'no exclusions declared').toBe(true)
  })

  it('no category counts a config or agents declaration file', () => {
    const offenders: string[] = []
    for (const cat of [3, 4, 5, 6, 8, 9, 10]) {
      for (const line of verify(cat)) {
        if (/^orchestrations\/(config|agents|prompts)\/.*\.json:/.test(line)) offenders.push(`cat${cat}: ${line.slice(0, 90)}`)
      }
    }
    expect(offenders.slice(0, 5),
      'declaration files are still counted — the headline number measures the config layer '
      + 'doing its job').toEqual([])
  })

  it('IT STILL SEES CODE: a literal in an engine script is still counted', () => {
    // Guard against the opposite failure: a scanner narrowed until it finds nothing reports
    // clean, which is the exact shape of the defect it exists to catch.
    const all = [3, 4, 5, 6, 8, 9, 10].flatMap(verify)
    expect(all.length, 'the scanner now finds nothing at all — it has been narrowed to blindness')
      .toBeGreaterThan(0)
    expect(all.some(l => /^orchestrations\/scripts\/.*\.(sh|js):/.test(l)),
      'no engine script site found — the scanner no longer looks at code').toBe(true)
  })
})
