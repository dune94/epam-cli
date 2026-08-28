import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A run labelled mockserver spent real money for 34 minutes. Three things had to line up:
//
//   1. the repo .env pins EPAM_ORCHESTRATION_PROVIDER=qwen (an OpenRouter route)
//   2. the set overlay sets it to the mock provider — correctly
//   3. a later re-read of .env OVERWROTE the overlay AND re-injected the real keys
//
// So the seam called a paid vendor with a live key while every config file said otherwise.
// This test drives the REAL launch order against the REAL libraries. It names no project:
// the fixture is built here, so the assertions are about the ORDER, not about metrolinx.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib')

function runLaunchOrder(opts: { scrubArgs: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'launchorder-'))
  const proj = join(dir, 'project')
  mkdirSync(proj)
  // The repo .env: real credentials and a paid-vendor provider pin.
  writeFileSync(join(dir, '.env'), [
    'ANTHROPIC_API_KEY=sk-ant-api03-LIVEKEYLIVEKEYLIVEKEY',
    'OPENROUTER_API_KEY=sk-or-v1-LIVEKEYLIVEKEYLIVEKEY',
    'EPAM_ORCHESTRATION_PROVIDER=paid-vendor',
    'JIRA_TOKEN=jira-must-survive',
  ].join('\n'))
  writeFileSync(join(proj, 'config.env'), 'PROJECT_NAME=fixture\n')
  writeFileSync(join(proj, 'config.mockserver.env'), 'EPAM_ORCHESTRATION_PROVIDER=mock-provider\n')

  const scrub = opts.scrubArgs
    ? `scrub_paid_keys "${dir}/.env" "${proj}/config.env"`
    : 'scrub_paid_keys'
  const script = `
    export EPAM_PROVIDER_SET=mockserver
    export EPAM_PROJECT_CONFIG_DIR="${proj}"
    . "${LIB}/env-file.sh"
    . "${LIB}/free-run-guard.sh"
    load_env_file_safe "${proj}/config.env"
    load_env_file_safe "${proj}/config.mockserver.env"
    ${scrub}
    load_env_file_safe "${dir}/.env"      # the clobber site
    for k in EPAM_ORCHESTRATION_PROVIDER ANTHROPIC_API_KEY OPENROUTER_API_KEY JIRA_TOKEN; do
      printf '%s=%s\\n' "$k" "\${!k-<unset>}"
    done
  `
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } as any })
  rmSync(dir, { recursive: true, force: true })
  expect(r.status, `harness failed: ${r.stderr}`).toBe(0)
  const out: Record<string, string> = {}
  for (const line of r.stdout.trim().split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  expect(Object.keys(out).length, 'harness rendered nothing — assertions would be vacuous').toBeGreaterThan(3)
  return out
}

describe('the launch order seals the credentials', () => {
  it('THE MONEY BUG: a later .env re-read must not restore a real key or a paid provider', () => {
    const got = runLaunchOrder({ scrubArgs: true })
    expect(got.ANTHROPIC_API_KEY).toBe('sk-mock-not-real')
    expect(got.OPENROUTER_API_KEY).toBe('sk-mock-not-real')
    // the negative assertion: no live key text survived anywhere
    expect(Object.values(got).join(' ')).not.toContain('LIVEKEY')
  })

  it("the set overlay's provider survives the .env pin — the run calls what it was told to", () => {
    const got = runLaunchOrder({ scrubArgs: true })
    expect(got.EPAM_ORCHESTRATION_PROVIDER).toBe('mock-provider')
    expect(got.EPAM_ORCHESTRATION_PROVIDER).not.toBe('paid-vendor')
  })

  it('a declared non-LLM credential still survives — scrubbing JIRA_TOKEN broke ingest once', () => {
    const got = runLaunchOrder({ scrubArgs: true })
    expect(got.JIRA_TOKEN).toBe('jira-must-survive')
  })

  it('the scrub is ORDERING-INDEPENDENT only when pre-seeded: without the files it cannot seal', () => {
    // Documents WHY the launcher passes the env files. scrub_paid_keys can only rewrite
    // what is already set; a credential that arrives later is never scrubbed at all.
    const got = runLaunchOrder({ scrubArgs: false })
    expect(got.ANTHROPIC_API_KEY).toContain('LIVEKEY')
  })
})
