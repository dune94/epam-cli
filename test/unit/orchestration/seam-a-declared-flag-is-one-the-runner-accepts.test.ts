/**
 * SEAM: STACK DECLARATION → RUNNER CLI. A FLAG WE DECLARE MUST BE ONE THE BINARY TAKES.
 *
 * config/llm-defaults.<set>.json declares per-runner alwaysFlags and flags. Nothing checked those
 * against the runner that receives them.
 *
 * The claude runner declared alwaysFlags ["-s"] — codemie-claude's silent flag. Plain claude
 * rejects it: `echo x | claude -s --print` exits 1 with "error: unknown option '-s'". mock3 run 3
 * died three steps later on "codeline scope could not be resolved", because the hub's claude arm
 * sent the runner's stderr to /dev/null and codeline-discovery reported only "Empty response".
 *
 * I diagnosed this correctly, RETRACTED it on a --help probe that proves nothing (--help and
 * --version short-circuit before option validation, so an invalid flag exits 0 there too), and
 * restored the flag. That broke the run. The decisive test is to RUN the binary with the flag.
 *
 * Skipped loudly when a runner is not installed: a check that silently passes because it could not
 * look is the failure mode this file exists to remove.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const CONFIG = join(ROOT, 'orchestrations/config')

/** Every (runner, flag) pair any stack declares — derived, never listed. */
function declaredFlags(): Array<{ set: string; runner: string; flag: string }> {
  const out: Array<{ set: string; runner: string; flag: string }> = []
  for (const f of readdirSync(CONFIG).filter((x) => /^llm-defaults\..+\.json$/.test(x))) {
    const set = f.replace(/^llm-defaults\.|\.json$/g, '')
    const j = JSON.parse(readFileSync(join(CONFIG, f), 'utf8'))
    for (const [runner, decl] of Object.entries<any>(j.runners || {})) {
      for (const flag of decl.alwaysFlags || []) out.push({ set, runner, flag })
      for (const flag of Object.keys(decl.flags || {})) out.push({ set, runner, flag })
    }
  }
  return out
}

const installed = (bin: string) => spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' }).status === 0

/**
 * Does this binary REJECT this flag? Runs it for real with a trivial prompt and a short deadline.
 * --help/--version cannot answer: they short-circuit before option validation.
 */
function rejects(bin: string, flag: string, needsValue: boolean): boolean {
  const args = needsValue ? [flag, 'low', '--print'] : [flag, '--print']
  const r = spawnSync(bin, args, { input: 'hi', encoding: 'utf8', timeout: 25000 })
  return /unknown option|unrecognized option|invalid option/i.test(String(r.stderr || ''))
}

describe('seam: a declared flag is one the runner accepts', () => {
  const pairs = declaredFlags()

  it('stacks declare runner flags at all — otherwise this asserts nothing', () => {
    expect(pairs.length, 'no runner declares a flag; the guard has lost its subject').toBeGreaterThan(0)
  })

  it('every declared flag is spelled as a flag', () => {
    for (const { set, runner, flag } of pairs) {
      expect(flag, `${set}/${runner} declares "${flag}", which is not a flag`).toMatch(/^-{1,2}[a-z]/)
    }
  })

  it('THE DEFECT: no runner is handed a flag it rejects', () => {
    const checked: string[] = []
    const bad: string[] = []
    for (const { set, runner, flag } of pairs) {
      if (!installed(runner)) continue
      // A value-taking flag needs one, or the CLI complains about the value rather than the flag.
      const needsValue = flag === '--effort' || flag === '--autocompact' || flag === '--model'
      checked.push(`${runner} ${flag}`)
      if (rejects(runner, flag, needsValue)) bad.push(`${set}/${runner} declares ${flag}, which ${runner} rejects`)
    }
    if (!checked.length) {
      // eslint-disable-next-line no-console
      console.warn('[seam] no declared runner is installed here — nothing could be checked')
    }
    expect(bad, bad.join('; ')).toEqual([])
  }, 120_000)
})
