/**
 * SEAM: FAILED ATTEMPT → ESCALATED RUNG. THE STRONGER MODEL MUST BE TOLD WHAT WENT WRONG.
 *
 * Escalation recorded the failure, stepped the rung, and handed the stronger model the IDENTICAL
 * prompt. So it re-derived the same answer from the same inputs with no idea what had just failed —
 * a parse error, a truncated reply, a refused tool call — and the extra money bought a second guess
 * rather than a correction.
 *
 * Same-rung retries already fed the reason back (refusalBlock in prompt-builder and the mint,
 * retryUntilParsed in discovery). Ladder escalation, which is the EXPENSIVE one, fed back nothing,
 * for every agent. last_err already held the previous attempt's stderr: nothing needed capturing,
 * it needed passing.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh')
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Fail the first attempt with `stderrText`; return the prompt the SECOND attempt received. */
function secondPrompt(stderrText: string): string {
  const d = mkdtempSync(join(tmpdir(), 'escal-')); dirs.push(d)
  const stub = join(d, 'stub')
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    'n=$(cat "$D_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$D_COUNT"',
    'cat > "$D_PROMPT.$n"',
    `if [ "$n" = "1" ]; then printf '%s\\n' ${JSON.stringify(stderrText)} >&2; exit 1; fi`,
    `printf '%s' '{"result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1},"num_turns":1}'`,
  ].join('\n'))
  chmodSync(stub, 0o755)
  spawnSync('bash', [HUB, '--provider', 'claude', '--model', 'claude-haiku-4-5-20251001'], {
    input: 'ORIGINAL PROMPT TEXT', encoding: 'utf8',
    env: {
      ...process.env, D_COUNT: join(d, 'n'), D_PROMPT: join(d, 'p'), CLAUDE_CMD: stub,
      EPAM_PROVIDER_SET: 'claude', EPAM_PLAN_EXECUTE: '0', EPAM_AGENT_NAME: 'probe',
      EPAM_CALL_MAX_ATTEMPTS: '2', NODE_BIN,
    },
  })
  const f = join(d, 'p.2')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

describe('seam: escalation carries the failure forward', () => {
  it('a second attempt happens at all — otherwise nothing below is exercised', () => {
    expect(secondPrompt('boom'), 'the retry never ran').not.toBe('')
  }, 60_000)

  it('THE DEFECT: the retried prompt names what the previous attempt got wrong', () => {
    const p = secondPrompt('boom: JSON parse error at line 3')
    expect(p, 'the stronger model was handed the identical prompt and told nothing')
      .toContain('JSON parse error at line 3')
    expect(p, 'the failure is not framed as a correction').toMatch(/previous attempt/i)
  }, 60_000)

  it('the ORIGINAL prompt is preserved, not replaced', () => {
    const p = secondPrompt('some failure')
    expect(p, 'the retry lost the actual task').toContain('ORIGINAL PROMPT TEXT')
  }, 60_000)

  it('A CREDENTIAL IN stderr NEVER REACHES THE PROMPT', () => {
    // stderr is arbitrary text from a vendor CLI and has carried keys before. A prompt is the one
    // place a leaked value is guaranteed to be transmitted.
    const p = secondPrompt('auth failed for sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG')
    expect(p, 'a credential-shaped string was copied into the prompt').not.toMatch(/sk-ant-api03-A/)
    expect(p, 'the failure was dropped entirely instead of redacted').toMatch(/REDACTED|auth failed/)
  }, 60_000)

  it('a first attempt is unchanged — no phantom refusal', () => {
    // An agent told it was refused, with nothing that actually failed, invents a reason.
    const d = mkdtempSync(join(tmpdir(), 'escal-first-')); dirs.push(d)
    const stub = join(d, 'stub')
    writeFileSync(stub, ['#!/usr/bin/env bash', 'cat > "$D_PROMPT.1"',
      `printf '%s' '{"result":"ok","total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1},"num_turns":1}'`].join('\n'))
    chmodSync(stub, 0o755)
    spawnSync('bash', [HUB, '--provider', 'claude', '--model', 'claude-haiku-4-5-20251001'], {
      input: 'ORIGINAL PROMPT TEXT', encoding: 'utf8',
      env: { ...process.env, D_PROMPT: join(d, 'p'), CLAUDE_CMD: stub, EPAM_PROVIDER_SET: 'claude',
             EPAM_PLAN_EXECUTE: '0', EPAM_AGENT_NAME: 'probe', NODE_BIN },
    })
    expect(readFileSync(join(d, 'p.1'), 'utf8')).not.toMatch(/previous attempt/i)
  }, 60_000)
})
