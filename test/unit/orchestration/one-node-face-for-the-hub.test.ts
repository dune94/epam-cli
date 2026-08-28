import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SEVEN JS CALLERS EACH BUILT THEIR OWN INVOCATION of the runner — ac-gate, kb-cli,
// kb-synthesizer, cpa-inference, mint-agents-step, spec-mode-runner, detective-rerun-step
// — plus codeline-discovery and topology-router with their own again. Each resolved its own
// provider, its own credential and its own timeout, so a fix to one never reached the others
// and the free-run seal held at only some of them.
//
// llm-call.js is the ONE node-side face of the hub. It resolves nothing about vendors itself:
// it hands off to llm-handler.sh, which is the only place a credential is read.
const LIB = join(process.cwd(), 'orchestrations/scripts/lib')
const CALLER = join(LIB, 'llm-call.js')

function withStubHub(fn: (dir: string, record: string) => any) {
  const dir = mkdtempSync(join(tmpdir(), 'llmcall-'))
  const record = join(dir, 'invoked.txt')
  const hub = join(dir, 'llm-handler.sh')
  writeFileSync(hub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\ncat > /dev/null\nprintf '%s' '{"topology":"parallel","reason":"stub"}'\n`)
  chmodSync(hub, 0o755)
  try { return fn(dir, record) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('one node-side face for the hub', () => {
  it('llm-call.js exists', () => {
    expect(existsSync(CALLER), 'lib/llm-call.js must exist').toBe(true)
  })

  it('EXECUTED: it dispatches to the hub and returns what the hub wrote', () => {
    withStubHub((dir, record) => {
      const r = spawnSync(process.execPath, ['-e', `
        const { callLlm } = require(${JSON.stringify(CALLER)});
        callLlm({ seam: 'topology-router', prompt: 'decide', model: 'claude-sonnet-5', hubPath: ${JSON.stringify(join(dir, 'llm-handler.sh'))} })
          .then(o => process.stdout.write(JSON.stringify(o)))
          .catch(e => { process.stderr.write(String(e)); process.exit(3); });
      `], { encoding: 'utf8', timeout: 30000 })
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)
      expect(existsSync(record), 'the hub was never invoked').toBe(true)
      const invoked = readFileSync(record, 'utf8')
      // it must pass the model through to the hub, not decide the vendor itself
      expect(invoked).toContain('claude-sonnet-5')
      expect(r.stdout).toContain('parallel')
    })
  })

  it('THE INVARIANT: it reads no vendor credential of its own', () => {
    const src = readFileSync(CALLER, 'utf8')
    // strip comments — the file explains WHY it must not, and that prose is not a read
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/(ANTHROPIC|OPENAI|OPENROUTER|MINIMAX|CLAUDE|QWEN)[A-Z_]*_(API_)?KEY/)
  })
})
