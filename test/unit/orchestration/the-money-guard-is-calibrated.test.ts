import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THE GUARD THAT DECIDES WHETHER A FREE RUN MAY LAUNCH, EXERCISED IN BOTH DIRECTIONS.
//
// assert_no_paid_key refuses to launch when a real vendor key is reachable. It is the last thing
// between a run labelled free and a real bill — and it has ALREADY FAILED OPEN once: the first
// version rebuilt the child's environment with `env $(for k in ...)`, silently dropped it, and
// reported "no usable vendor key is reachable" with a live sk-ant- key exported one line above.
//
// It had no test. Neither did _free_run_real_key_re, which decides what "real" means. A guard
// that can stop a run and that nothing executes is the exact shape of the three that shipped
// inert on 2026-08-20 while the suite was green.
//
// BOTH DIRECTIONS MATTER. A guard that always refuses is useless and gets disabled; a guard that
// always passes is worse than none, because it converts a doubt into a false assurance.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib/free-run-guard.sh')

function assertNoPaidKey(envVars: Record<string, string>, opts: { projectEnv?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moneyguard-'))
  const proj = join(dir, 'project'); mkdirSync(proj, { recursive: true })
  if (opts.projectEnv) writeFileSync(join(proj, 'config.env'), opts.projectEnv)
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; assert_no_paid_key ${JSON.stringify(proj)}; echo "rc=$?"`],
    { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...envVars } as any })
  rmSync(dir, { recursive: true, force: true })
  return { out: (r.stdout || '') + (r.stderr || ''), refused: /rc=[^0]/.test(r.stdout || '') }
}

function realKeyRe(): string {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; _free_run_real_key_re`],
    { encoding: 'utf8', timeout: 20000 })
  return (r.stdout || '').trim()
}

function matches(value: string): boolean {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; printf '%s\\n' ${JSON.stringify(value)} | grep -qE "$(_free_run_real_key_re)" && echo YES || echo NO`],
    { encoding: 'utf8', timeout: 20000 })
  return /YES/.test(r.stdout || '')
}

describe('the money guard is calibrated', () => {
  it('_free_run_real_key_re is non-empty — an empty pattern matches nothing and passes everything', () => {
    expect(realKeyRe()).not.toBe('')
  })

  // WHAT "REAL" MEANS. Driven by the shapes actually seen in this repo's .env.
  it.each([
    ['sk-ant-api03-86bLT7Ap7d3ByUzjYpsB4ahbT3Ius_ub7VvFDJWFxf6', true,  'an Anthropic key'],
    ['sk-or-v1-0123456789abcdef0123456789abcdef',                true,  'an OpenRouter key'],
    ['sk-abcdefghijklmnopqrstuvwxyz0123',                        true,  'a generic vendor key'],
    ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh',             true,  'a JWT'],
    ['sk-mock-not-real',                                         false, 'the scrub placeholder'],
    ['',                                                         false, 'an empty value'],
    ['jira-token-abcdefghijklmnop',                              false, 'a non-vendor credential'],
  ])('%s -> real=%s (%s)', (value, expected) => {
    expect(matches(String(value))).toBe(expected as boolean)
  })

  it('REFUSES when a real vendor key is reachable — the direction that failed open', () => {
    const r = assertNoPaidKey({ ANTHROPIC_API_KEY: 'sk-ant-api03-86bLT7Ap7d3ByUzjYpsB4ahbT3Ius_ub' })
    expect(r.refused, 'a live key was reachable and the guard said launch').toBe(true)
    expect(r.out).toMatch(/REFUSING TO LAUNCH/)
    expect(r.out, 'the refusal must name the variable, or nobody can act on it')
      .toMatch(/ANTHROPIC_API_KEY/)
  })

  it('PASSES when every key is scrubbed — a guard that always refuses gets turned off', () => {
    const r = assertNoPaidKey({
      ANTHROPIC_API_KEY: 'sk-mock-not-real',
      OPENROUTER_API_KEY: 'sk-mock-not-real',
    })
    expect(r.refused, 'a properly scrubbed environment was refused').toBe(false)
    expect(r.out).toMatch(/no usable vendor key is reachable/)
  })

  it('a declared non-LLM credential does NOT trip it — by design, not by luck of a regex', () => {
    // LANGFUSE_SECRET_KEY is "sk-lf-…" and escapes the vendor shape only by a hyphen. The keep
    // list is what makes that deliberate.
    const r = assertNoPaidKey({ JIRA_TOKEN: 'jira-abcdefghijklmnopqrst', LANGFUSE_PUBLIC_KEY: 'pk-lf-abcdefghijklmnop' })
    expect(r.refused, 'a non-LLM credential blocked a free run').toBe(false)
  })

  it('THE CHILD REALLY INHERITS: a key reaching the child only via the project env is caught', () => {
    // This is the mechanism that broke. The key is not in the parent environment at all — it is
    // loaded by the child from the project config, exactly as a launch would load it.
    const r = assertNoPaidKey({}, { projectEnv: 'ANTHROPIC_API_KEY=sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQ\n' })
    expect(r.refused, 'a key arriving through the project env was not seen by the guard').toBe(true)
  })
})
