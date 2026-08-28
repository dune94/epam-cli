/**
 * ONE PROJECT'S CLIENT DOCUMENTATION MUST NEVER REACH ANOTHER'S PROMPTS.
 *
 * mint-agents-step.js resolves referenced documents by reading $LOG_DIR/referenced-docs.json,
 * then $LOG_DIR/ticket-documents.json, and hands whatever it finds to the estate survey, the
 * mint and the roster review. LOG_DIR is SHARED across projects and nothing cleared those files.
 *
 * Found live 2026-08-26: a mock3 run opened its roster-review prompt with two Contentstack pages
 * fetched for METROLINX on 2026-08-07 — nineteen days earlier. Forty-one mentions of another
 * client's CMS, paid for on every affected seam, in a project with no connection to it.
 *
 * The reset is the mechanism: anything a later step READS out of LOG_DIR is run state.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const RESET = join(ROOT, 'orchestrations/scripts/pre-run-reset.sh')
const MINT = join(ROOT, 'orchestrations/scripts/mint-agents-step.js')

/** The filenames the mint actually reads — derived from the producer, never listed here. */
function cacheNames(): string[] {
  const src = readFileSync(MINT, 'utf8')
  const fn = src.slice(src.indexOf('async function referencedDocs'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  const names = [...body.matchAll(/path\.join\(logDir,\s*'([^']+)'\)/g)].map((m) => m[1])
  return [...new Set(names)]
}

describe('no project inherits another project\'s fetched documents', () => {
  it('the mint reads at least one document cache out of LOG_DIR — otherwise this test is moot', () => {
    expect(cacheNames().length,
      'referencedDocs no longer reads a cache from logDir; if it moved, this guard must follow it')
      .toBeGreaterThan(0)
  })

  it('THE LEAK: every cache the mint reads is cleared by the pre-run reset', () => {
    const reset = readFileSync(RESET, 'utf8')
    for (const name of cacheNames()) {
      expect(reset, `${name} is read into agent prompts and never cleared — the next project `
        + 'inherits whatever the last one fetched').toContain(name)
    }
  })

  it('the reset FAILS LOUDLY rather than continuing if it cannot clear them', () => {
    const reset = readFileSync(RESET, 'utf8')
    const i = reset.indexOf('referenced-docs.json')
    expect(i, 'the clearing block is gone').toBeGreaterThan(-1)
    const block = reset.slice(i, i + 1800)
    expect(block, 'a cache that survives the reset is announced as a clean slate')
      .toMatch(/fail_contamination/)
  })

  it('no stale cache is sitting in the shared log dir right now', () => {
    // A live check, not a code check: this is the state a run would actually start from.
    const logDir = join(ROOT, 'orchestrations/logs')
    for (const name of cacheNames()) {
      const f = join(logDir, name)
      if (!existsSync(f)) continue
      expect.fail(
        `${f} exists before any run has started. Whatever project fetched it, the next run of a `
        + 'DIFFERENT project would put its contents in the estate survey, the mint and the roster '
        + 'review prompts.')
    }
  })
})
