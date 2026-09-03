/**
 * PLAN/EXECUTE DOUBLES EVERY CALL, AND CLAUDE PLANS INTERNALLY.
 *
 * llm-handler.sh makes a PLAN call before every answer ("state your PLAN, and nothing else"),
 * discards it, and calls again. Measured 2026-08-26 through the real hub on claude-haiku-4-5,
 * same prompt: $0.04947 with it, $0.01969 without — the plan pass is 55% of every call and calls
 * cost 2.5x more with it on. Across mock3 run 9 that is $6.83 becoming roughly $2.73.
 *
 * It was added for a TOOL-BUDGET reason, not a reasoning one: the detective "explored twice —
 * seven calls to plan, seven more to answer", and the fix was to strip tools from the plan pass.
 * Claude Code plans internally with extended thinking, so the round buys little here.
 *
 * Declared in the CLAUDE overlays only. openrouter keeps it, where it was tuned and where the
 * models have no comparable internal planning.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh')
const PROJECTS = join(ROOT, 'orchestrations/projects')
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Count the model calls one hub invocation makes, with a stubbed runner. No spend. */
function callsMade(planExecute: string): number {
  const d = mkdtempSync(join(tmpdir(), 'plan-exec-')); dirs.push(d)
  const counter = join(d, 'count')
  const stub = join(d, 'stub')
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `echo CALL >> ${JSON.stringify(counter)}`,
    'cat > /dev/null',
    `printf '%s' '{"result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1},"num_turns":1}'`,
  ].join('\n'))
  chmodSync(stub, 0o755)
  writeFileSync(counter, '')
  spawnSync('bash', [HUB, '--provider', 'claude', '--model', 'claude-haiku-4-5-20251001'], {
    input: 'hi', encoding: 'utf8',
    env: {
      ...process.env, CLAUDE_CMD: stub, EPAM_PLAN_EXECUTE: planExecute,
      EPAM_PROVIDER_SET: 'claude', EPAM_AGENT_NAME: 'probe', NODE_BIN,
    },
  })
  return readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
}

describe('the claude stack does not pay to plan twice', () => {
  it('the harness reaches the runner at all — otherwise the counts below prove nothing', () => {
    expect(callsMade('1'), 'the stub was never invoked').toBeGreaterThan(0)
  })

  it('THE SAVING: plan/execute off makes ONE call where it made two', () => {
    expect(callsMade('1'), 'plan/execute no longer makes a planning call').toBe(2)
    expect(callsMade('0'), 'the planning call is still being made with it off').toBe(1)
  })

  it('every claude overlay declares it off', () => {
    const overlays = readdirSync(PROJECTS)
      .map((p) => join(PROJECTS, p, 'config.claude.env'))
      .filter((f) => existsSync(f))
    expect(overlays.length, 'no claude overlays found — nothing would be scoped').toBeGreaterThan(0)
    for (const f of overlays) {
      expect(readFileSync(f, 'utf8'), `${f} does not turn plan/execute off`)
        .toMatch(/^EPAM_PLAN_EXECUTE=0$/m)
    }
  })

  it('THE LIMIT: openrouter is untouched, where the behaviour was tuned', () => {
    for (const p of readdirSync(PROJECTS)) {
      const f = join(PROJECTS, p, 'config.openrouter.env')
      if (!existsSync(f)) continue
      expect(readFileSync(f, 'utf8'), `${p}'s openrouter overlay was changed too`)
        .not.toMatch(/EPAM_PLAN_EXECUTE/)
    }
  })

  it('the hub still honours a seam that asks for planning explicitly', () => {
    // The overlay is a default, not a removal: a seam that needs the plan pass can set it back.
    expect(readFileSync(HUB, 'utf8'), 'the plan pass is gone from the hub entirely')
      .toMatch(/EPAM_PLAN_EXECUTE:-1/)
  })
})
