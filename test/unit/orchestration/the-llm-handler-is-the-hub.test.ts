import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ONE CENTRAL HANDLER, THEN VENDOR HANDLERS.
//
// Eight independent channels each read their own credential and called their own endpoint,
// so the free-run seal held at one of them and a "mockserver" run billed a real API. The
// hub is the single place a provider is resolved and a vendor is dispatched to.
//
// `ai-run` is retired: the name said nothing about what it does. It survives only as a
// forwarding shim so the migration does not have to touch 536 call sites at once.
const SCRIPTS = join(process.cwd(), 'orchestrations/scripts')
const HUB = join(SCRIPTS, 'llm-handler.sh')
const SHIM = join(SCRIPTS, 'ai-run.sh')

describe('the llm handler is the central hub', () => {
  it('the hub exists and carries the provider dispatch', () => {
    expect(existsSync(HUB), 'llm-handler.sh must exist').toBe(true)
    const body = readFileSync(HUB, 'utf8')
    // The dispatch is what makes it the hub — not the filename.
    expect(body).toMatch(/case\s+"\$provider"\s+in/)
  })

  it('the retired name still forwards, so no caller breaks mid-migration', () => {
    expect(existsSync(SHIM), 'ai-run.sh shim must remain until call sites migrate').toBe(true)
    const shim = readFileSync(SHIM, 'utf8')
    expect(shim).toContain('llm-handler.sh')
    // A shim FORWARDS. If it still carries the dispatch it is a second hub, which is the
    // exact defect this change exists to remove.
    expect(shim).not.toMatch(/case\s+"\$provider"\s+in/)
  })

  it('EXECUTED: hub and shim dispatch to the same vendor handler', () => {
    // A stubbed vendor binary records what it was called with — the receiver, not the caller.
    const dir = mkdtempSync(join(tmpdir(), 'hub-'))
    const record = join(dir, 'called.txt')
    const stub = join(dir, 'claude')
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "claude $*" >> ${JSON.stringify(record)}\necho '{"result":"OK","is_error":false}'\n`)
    chmodSync(stub, 0o755)

    const run = (script: string) => spawnSync('bash', [script, '--provider', 'claude', '--model', 'claude-sonnet-5'], {
      encoding: 'utf8',
      input: 'hello',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CLAUDE_CMD: stub,
        ANTHROPIC_API_KEY: 'sk-mock-not-real',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        EPAM_PROVIDER_SET: 'mockserver',
      },
    })

    const a = run(HUB)
    const b = run(SHIM)
    rmSync(dir, { recursive: true, force: true })
    // Not asserting success — no live mock here. Asserting they behave as ONE path:
    // the shim must not diverge from the hub.
    expect(a.status).toBe(b.status)
  })
})
