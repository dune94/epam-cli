/**
 * SEAM: LADDER → RUNNER ARGV. A RESOLVED RUNG THAT NEVER ARRIVES IS DECORATION.
 *
 * resolvePromptExec builds the execSpec ONCE at startup from process.env, where AI_MODEL and
 * EPAM_MODEL are both empty — so argv carried no --model. The hub reads only AI_MODEL, and nothing
 * bridged EPAM_MODEL to it. Every runClaude seam therefore ran on Claude Code's OWN default model
 * rather than the rung its ladder resolved, and could not escalate: there was no starting rung to
 * escalate from.
 *
 * Proven three ways on 2026-08-26: the seam resolved claude-haiku-4-5 while argv held only
 * ["--provider","claude"]; a stubbed runner with EPAM_MODEL in the env received no --model; the
 * same call with --model passed explicitly received it intact. It is why moving prompt-builder to
 * the cheap rung changed nothing — cost stayed at $0.111/call against haiku's measured $0.039 —
 * and why every cost row carried a blank model.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const SCRIPTS = join(ROOT, 'orchestrations/scripts')
const PROJECT = join(ROOT, 'orchestrations/projects/mock3')
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Drive the REAL runClaude with a stubbed runner and return the argv it was handed. */
function argvFor(seam: string, execArgs: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'ladder-argv-')); dirs.push(d)
  const stub = join(d, 'stub'); const log = join(d, 'argv')
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'cat > /dev/null',
    `printf '%s' '{"result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1},"num_turns":1}'`,
  ].join('\n'))
  chmodSync(stub, 0o755); writeFileSync(log, '')

  spawnSync('bash', ['-c',
    `. ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))}; `
    + `export_model_ladders ${JSON.stringify(join(PROJECT, 'llm-settings.json'))} >/dev/null 2>&1; `
    + `"$NODE_BIN" -e '
        const spec = require(${JSON.stringify(join(SCRIPTS, 'spec-mode-runner.js'))});
        const { seamInvocationEnv } = require(${JSON.stringify(join(SCRIPTS, 'lib/seam-invocation.js'))});
        const env = seamInvocationEnv(process.argv[1], ${JSON.stringify(join(ROOT, 'orchestrations/agents'))}) || {};
        env.EPAM_PLAN_EXECUTE = "0";
        spec.runClaude({ cmd: ${JSON.stringify(join(SCRIPTS, 'llm-handler.sh'))}, args: JSON.parse(process.argv[2]) },
          "hi", "/dev/null", env, { costAgent: "probe" }).catch(() => {});
      ' ${JSON.stringify(seam)} ${JSON.stringify(JSON.stringify(execArgs))}; sleep 4`],
  { encoding: 'utf8', env: {
    ...process.env, ARGV_LOG: log, CLAUDE_CMD: stub, NODE_BIN,
    EPAM_PROVIDER_SET: 'claude', EPAM_PROJECT_CONFIG_DIR: PROJECT, EPAM_ORCHESTRATION_PROVIDER: 'claude',
  } })
  return readFileSync(log, 'utf8')
}

describe('seam: the ladder\'s model reaches the runner', () => {
  it('the harness reaches the runner — otherwise every assertion below is vacuous', () => {
    expect(argvFor('prompt-builder', ['--provider', 'claude']), 'the stub was never invoked')
      .toContain('--print')
  }, 60_000)

  it('THE DEFECT: a seam whose execSpec names no model still gets its resolved rung', () => {
    const argv = argvFor('prompt-builder', ['--provider', 'claude'])
    expect(argv, 'the resolved rung never reached the runner, so the ladder is decoration and the '
      + 'seam runs on whatever the CLI defaults to').toMatch(/--model claude-/)
  }, 60_000)

  it('ARGV WINS — an explicitly named model is not overridden', () => {
    // A caller that named a model meant it; the bridge only fills a gap, so per-call overrides and
    // the escalation ladder both keep working.
    const argv = argvFor('prompt-builder', ['--provider', 'claude', '--model', 'claude-opus-5'])
    expect(argv).toContain('--model claude-opus-5')
    expect(argv, 'the bridge overrode a model the caller named').not.toContain('haiku')
  }, 60_000)
})
