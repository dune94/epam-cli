import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// THE GUARD THAT DECIDES WHETHER AGENTS MAY WRITE TO A CLIENT REPOSITORY.
//
// perimeter_is_write_allowed returns non-zero to LOCK a codeline. Getting it wrong in one
// direction lets agents edit a client's baseline branch; in the other it freezes a run that
// should proceed. It had no test.
//
// Every case below is built as a real git repository and the real function is run against it —
// a stubbed `git` would only prove the stub.
const REPO = process.cwd()
const LIB = join(REPO, 'orchestrations/scripts/lib/codeline-write-perimeter.sh')

function makeRepo(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'perimeter-'))
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  spawnSync('git', ['init', '-q', dir])
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 'T')
  writeFileSync(join(dir, 'file.txt'), 'x')
  git('add', '-A'); git('commit', '-qm', 'init')
  setup(dir)
  return dir
}

function writeAllowed(dir: string, baseline = 'main'): boolean {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(LIB)}; perimeter_is_write_allowed ${JSON.stringify(dir)} && echo ALLOWED || echo LOCKED`],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, JIRA_BASELINE_BRANCH: baseline } })
  return /ALLOWED/.test(r.stdout || '')
}

describe('the write perimeter guard is calibrated', () => {
  it('LOCKED on the baseline branch — agents may not edit a client baseline', () => {
    const dir = makeRepo(d => spawnSync('git', ['-C', d, 'branch', '-M', 'develop']))
    const allowed = writeAllowed(dir, 'develop')
    rmSync(dir, { recursive: true, force: true })
    expect(allowed, 'writing was allowed on the declared baseline branch').toBe(false)
  })

  it('ALLOWED on a story branch — a guard that always locks stops every run', () => {
    const dir = makeRepo(d => {
      spawnSync('git', ['-C', d, 'branch', '-M', 'develop'])
      spawnSync('git', ['-C', d, 'checkout', '-qb', 'bugfix/AMSD-1'])
    })
    const allowed = writeAllowed(dir, 'develop')
    rmSync(dir, { recursive: true, force: true })
    expect(allowed, 'a story branch was locked — no work could land').toBe(true)
  })

  it('LOCKED when HEAD is detached — nothing can be committed from there anyway', () => {
    const dir = makeRepo(d => {
      const sha = spawnSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      spawnSync('git', ['-C', d, 'checkout', '-q', sha])
    })
    const allowed = writeAllowed(dir)
    rmSync(dir, { recursive: true, force: true })
    expect(allowed, 'a detached HEAD was treated as writable').toBe(false)
  })

  it('a path that is not a repository is NOT ours to lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notarepo-'))
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const allowed = writeAllowed(dir)
    rmSync(dir, { recursive: true, force: true })
    expect(allowed, 'a non-repository was locked — the guard would freeze unrelated paths').toBe(true)
  })

  it('the baseline is DECLARED: changing it changes which branch is locked', () => {
    // Proves the guard reads configuration rather than carrying a branch name of its own.
    const dir = makeRepo(d => spawnSync('git', ['-C', d, 'branch', '-M', 'release']))
    const lockedAsBaseline = !writeAllowed(dir, 'release')
    const allowedWhenNotBaseline = writeAllowed(dir, 'develop')
    rmSync(dir, { recursive: true, force: true })
    expect(lockedAsBaseline, 'the declared baseline was not locked').toBe(true)
    expect(allowedWhenNotBaseline, 'a branch that is not the baseline was locked anyway').toBe(true)
  })
})
