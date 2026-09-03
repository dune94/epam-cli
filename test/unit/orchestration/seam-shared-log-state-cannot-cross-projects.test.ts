/**
 * SEAM: ONE RUN'S ARTEFACTS → THE NEXT RUN'S PROMPTS. LOG_DIR IS SHARED.
 *
 * LOG_DIR is shared across projects, and several steps READ state back out of it. Anything read
 * there is run state, and run state that survives reaches the next project's prompts.
 *
 * Live 2026-08-26: mock3's roster-review prompt opened with two Contentstack pages fetched for
 * METROLINX on 2026-08-07 — nineteen days stale, forty-one mentions of another client's CMS, paid
 * for on every affected seam. mint-agents-step reads $LOG_DIR/referenced-docs.json and hands
 * whatever it finds to the estate survey, the mint and the roster review.
 *
 * Third time the reset was caught missing shared state, after run-scoped review artefacts and the
 * published agent-input store. So this asserts the RULE rather than the instance: every file the
 * pipeline reads back out of LOG_DIR is cleared by the pre-run reset.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const SCRIPTS = join(ROOT, 'orchestrations/scripts')
const RESET = readFileSync(join(SCRIPTS, 'pre-run-reset.sh'), 'utf8')
const LOGS = join(ROOT, 'orchestrations/logs')

/**
 * Files the pipeline READS back out of LOG_DIR — derived from the code, not listed.
 * Matches path.join(logDir, 'x.json') and "$LOG_DIR/x.json" in a read position.
 */
function readBackFiles(): string[] {
  const names = new Set<string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
      if (!/\.(js|sh)$/.test(e.name)) continue
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/readFileSync\(\s*path\.join\(\s*logDir\s*,\s*'([^']+\.json)'/g)) names.add(m[1])
      for (const m of src.matchAll(/path\.join\(logDir,\s*'([^']+\.json)'\)[\s\S]{0,80}?readFileSync/g)) names.add(m[1])
    }
  }
  walk(SCRIPTS)
  return [...names]
}

describe('seam: shared log state cannot cross projects', () => {
  it('the pipeline does read state back out of LOG_DIR — otherwise this asserts nothing', () => {
    expect(readBackFiles().length, 'nothing reads a json file out of logDir; the derivation broke')
      .toBeGreaterThan(0)
  })

  it('THE LEAK: every file read back out of LOG_DIR is cleared by the reset', () => {
    const uncleared = readBackFiles().filter((n) => !RESET.includes(n))
    expect(uncleared,
      'these are read into a run and never cleared, so the next project inherits whatever the last '
      + 'one left: ' + uncleared.join(', ')).toEqual([])
  })

  it('the reset FAILS LOUDLY rather than announcing a clean slate it did not deliver', () => {
    // Anchored on the clearing LOOP, not the first textual mention — that is now a comment, and a
    // window measured from prose measures how much prose there is.
    const i = RESET.indexOf('for _td in')
    expect(i, 'the cross-run artefact clearing is gone').toBeGreaterThan(-1)
    expect(RESET.slice(i, i + 1800),
      'a cache that survives the reset would be announced as a clean slate').toMatch(/fail_contamination/)
  })

  it('LIVE: no stale cross-project artefact is sitting in the shared log dir right now', () => {
    // The state a run would actually start from, not a claim about the code.
    const stale = readBackFiles()
      .map((n) => join(LOGS, n))
      .filter((f) => existsSync(f))
      .filter((f) => (Date.now() - statSync(f).mtimeMs) > 24 * 3600 * 1000)
    expect(stale,
      'these predate today and would be read into the next run of ANY project: ' + stale.join(', '))
      .toEqual([])
  })
})
