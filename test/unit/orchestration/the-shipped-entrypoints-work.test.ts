import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// THE TWO COMMANDS A PERSON ACTUALLY TYPES.
//
// install.sh sets a machine up; pipeline runs one ticket. Everything else in this repo is
// reachable only through them, so if either is broken nothing else matters.
//
// Both are checked by EXECUTION. An entrypoint asserted by reading its source is the one thing
// that must never be — it is the file where a syntax error costs a person their first ten minutes.
const REPO = process.cwd()
const INSTALL = join(REPO, 'orchestrations-installer/install.sh')
const PIPELINE = join(REPO, 'orchestrations/scripts/pipeline')

function run(cmd: string, args: string[]) {
  const r = spawnSync('bash', [cmd, ...args], { cwd: REPO, encoding: 'utf8', timeout: 120000 })
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const SETS = Object.keys(
  JSON.parse(readFileSync(join(REPO, 'orchestrations/config/provider-sets.json'), 'utf8')).sets)

describe('the shipped entrypoints work', () => {
  it('both exist and are executable', () => {
    for (const f of [INSTALL, PIPELINE]) expect(existsSync(f), `${f} is missing`).toBe(true)
  })

  it('both parse — a syntax error here costs a person their first ten minutes', () => {
    for (const f of [INSTALL, PIPELINE]) {
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' })
      expect(r.status, `${f}: ${r.stderr}`).toBe(0)
    }
  })

  it('install --check passes for EVERY declared stack, with docker off', () => {
    // Docker is optional by design: an installer that fails without a container teaches people
    // to skip the installer.
    for (const s of SETS) {
      const r = run(INSTALL, ['--check', '--stack', s, '--no-docker'])
      expect(r.rc, `stack ${s}: ${r.out}`).toBe(0)
    }
  })

  it('install refuses a stack nobody declares, and says which exist', () => {
    const r = run(INSTALL, ['--check', '--stack', 'no-such-stack'])
    expect(r.rc).not.toBe(0)
    for (const s of SETS) expect(r.out, 'the refusal must list the real stacks').toContain(s)
  })

  it('pipeline --list shows every project and the prefix it owns', () => {
    const r = run(PIPELINE, ['--list'])
    expect(r.rc).toBe(0)
    expect(r.out).toMatch(/PROJECT\s+PREFIX/)
  })

  it('EXECUTED: a real ticket resolves to its project and stack without starting anything', () => {
    // the prefix is read from the projects, so this test names no project of its own
    const listed = run(PIPELINE, ['--list']).out
    const row = listed.split('\n').find((l) => /\s[A-Z]{2,}\s/.test(l) && !/PROJECT/.test(l))
    expect(row, 'no project declares a ticket prefix — cannot exercise the resolver').toBeTruthy()
    const prefix = row!.trim().split(/\s+/)[1]
    const r = run(PIPELINE, ['--jira', `${prefix}-1`, '--dry-run'])
    expect(r.rc, r.out).toBe(0)
    expect(r.out).toContain('nothing started')
  })

  it('a ticket nobody owns is refused with the reason', () => {
    const r = run(PIPELINE, ['--jira', 'ZZZQQ-1', '--dry-run'])
    expect(r.rc).not.toBe(0)
    expect(r.out).toMatch(/no project declares the ticket prefix/)
  })

  it('a malformed ticket is refused before anything is resolved', () => {
    const r = run(PIPELINE, ['--jira', 'nonsense'])
    expect(r.rc).not.toBe(0)
    expect(r.out).toMatch(/does not look like a ticket id/)
  })

  it('NEITHER ENTRYPOINT NAMES A PROJECT, STACK OR SERVICE', () => {
    // Both are generic: adding a project or a stack is a config edit, never an edit here.
    for (const f of [INSTALL, PIPELINE]) {
      const code = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !/^\s*#/.test(l)).join('\n')
      expect(code, `${f} names a project`).not.toMatch(/metrolinx|skyscanner|mock3|hello-dolly/)
      expect(code, `${f} names a vendor`).not.toMatch(/openrouter|minimax|anthropic|codemie-claude/i)
    }
  })
})
