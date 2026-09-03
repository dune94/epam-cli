import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A free run scrubs every credential, then a script re-reads .env and the REAL key is
// back. The parent process looked sealed and its child carried a live sk-ant key to a
// paid API for 34 minutes. /proc/PID/environ shows the env a process was EXEC'd with,
// which is why the parent read as scrubbed and only the child exposed the leak.
//
// The contract: a value that is already set wins over the file's. A .env supplies
// DEFAULTS; it does not overwrite a decision the caller already made.
const LIB = join(process.cwd(), 'orchestrations/scripts/lib/env-file.sh')

function loadWith(preset: Record<string, string>, fileBody: string, mode = ''): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'envfile-'))
  const envFile = join(dir, '.env')
  writeFileSync(envFile, fileBody)
  const script = `
    set -a
    ${Object.entries(preset).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n    ')}
    set +a
    . ${JSON.stringify(LIB)}
    load_env_file_safe ${JSON.stringify(envFile)} ${mode}
    for k in ${Object.keys(preset).join(' ')} FROM_FILE_ONLY; do
      printf '%s=%s\\n' "$k" "\${!k-<unset>}"
    done
  `
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  expect(r.status, `harness failed: ${r.stderr}`).toBe(0)
  const out: Record<string, string> = {}
  for (const line of r.stdout.trim().split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  // Guard against a vacuous pass: if the harness parsed nothing, every assertion below
  // would trivially hold.
  expect(Object.keys(out).length).toBeGreaterThan(0)
  return out
}

const REAL_ENV = [
  'ANTHROPIC_API_KEY=sk-ant-api03-REALKEYREALKEY',
  'OPENROUTER_API_KEY=sk-or-v1-REALKEYREALKEY',
  'FROM_FILE_ONLY=supplied-by-file',
].join('\n')

describe('a scrubbed credential survives a .env reload', () => {
  it('THE LEAK: a scrubbed key is NOT overwritten by the real one in .env', () => {
    const got = loadWith(
      { ANTHROPIC_API_KEY: 'sk-mock-not-real', OPENROUTER_API_KEY: 'sk-mock-not-real' },
      REAL_ENV,
    )
    expect(got.ANTHROPIC_API_KEY).toBe('sk-mock-not-real')
    expect(got.OPENROUTER_API_KEY).toBe('sk-mock-not-real')
    // and the real value must not have leaked through under any name
    expect(Object.values(got).join(' ')).not.toContain('REALKEYREALKEY')
  })

  it('a .env still SUPPLIES what nothing has set — a real run must still authenticate', () => {
    const got = loadWith({ ANTHROPIC_API_KEY: '' }, REAL_ENV)
    expect(got.ANTHROPIC_API_KEY).toBe('sk-ant-api03-REALKEYREALKEY')
    expect(got.FROM_FILE_ONLY).toBe('supplied-by-file')
  })

  it('explicit overwrite mode still overwrites, for the caller that means it', () => {
    const got = loadWith({ ANTHROPIC_API_KEY: 'sk-mock-not-real' }, REAL_ENV, 'overwrite')
    expect(got.ANTHROPIC_API_KEY).toBe('sk-ant-api03-REALKEYREALKEY')
  })
})
