import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// A SERVICE URL HAS ONE HOME: config/services.json.
//
// It declares each service's URL and its override env var, and lib/service-urls.sh reads them —
// "EDIT HERE, no code change". Two engine scripts still spelled a declared URL out anyway, so
// moving a service meant editing config AND hunting literals, and the literal wins wherever it
// was missed.
//
// The list of services is DERIVED from the declaration, so a service added tomorrow is guarded
// tomorrow rather than when someone remembers this file.
const REPO = process.cwd()
const SERVICES = JSON.parse(readFileSync(join(REPO, 'orchestrations/config/services.json'), 'utf8')).services

// Files that are ALLOWED to name a URL: the declaration itself and the reader that resolves it.
const ALLOWED = /config\/services\.json|lib\/service-urls\.sh/

function grepFor(pattern: string): string[] {
  try {
    const out = execFileSync('grep', ['-rnE', pattern,
      'orchestrations/scripts', '--include=*.sh', '--include=*.js'], { cwd: REPO, encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean)
      // A COMMENT NAMING A PORT IS DOCUMENTATION, NOT A SECOND HOME. jira-client.js documents
      // the shape of JIRA_URL with an example; stripping that would make the doc worse and the
      // code no better. Only executable lines are held to the rule.
      .filter(l => {
        const body = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1).trim()
        return !(body.startsWith('#') || body.startsWith('//') || body.startsWith('*'))
      })
      .map(l => l.slice(0, l.indexOf(':')))
      .filter(f => !ALLOWED.test(f))
  } catch (e: any) {
    if (e.status === 1) return []
    throw e
  }
}

describe('a service url has one home', () => {
  it('services.json declares services — otherwise this suite is vacuous', () => {
    expect(Object.keys(SERVICES).length).toBeGreaterThan(0)
  })

  for (const [name, def] of Object.entries(SERVICES) as any) {
    const port = String(def.url).split(':').pop()
    it(`no engine script spells the ${name} url (:${port})`, () => {
      // the port alone is the giveaway: localhost:<port> anywhere is a second home
      const offenders = grepFor(`(localhost|127\\.0\\.0\\.1):${port}`)
      expect(offenders,
        `these name ${name}'s port directly. Use \`. lib/service-urls.sh; service_url ${name}\` `
        + `so moving the service stays a config edit.`).toEqual([])
    })
  }

  // _service_config_path is a GUARD: it returns non-zero when it cannot find the declaration,
  // and service_url stops there. A blocking function that no test executes is how three guards
  // shipped inert on 2026-08-20 while the suite was green.
  describe('_service_config_path — the guard that decides whether anything resolves', () => {
    const LIB = join(REPO, 'orchestrations/scripts/lib/service-urls.sh')

    function runIn(cwd: string, scriptDir?: string) {
      // EXPORTED, not a temp assignment: `VAR=x . file` applies only to the `.` builtin, so the
      // variable was gone by the time the guard ran and it silently searched the real repo —
      // the test passed while exercising nothing it claimed to.
      const setup = scriptDir ? `export SCRIPT_DIR=${JSON.stringify(scriptDir)}; ` : ''
      return spawnSync('bash', ['-c',
        `${setup}. ${JSON.stringify(LIB)}; _service_config_path && echo " <- rc=0" || echo "NOT_FOUND rc=$?"`],
        { cwd, encoding: 'utf8', timeout: 20000 })
    }

    it('finds the declaration from a nested working directory', () => {
      const r = runIn(join(REPO, 'orchestrations/scripts/lib'))
      expect(r.stdout, `stderr: ${r.stderr}`).toContain('services.json')
      expect(r.stdout).toContain('rc=0')
    })

    it('REFUSES when there is no declaration — it never invents a port', () => {
      const dir = mkdtempSync(join(tmpdir(), 'no-services-'))
      // SCRIPT_DIR points the search at a tree with no services.json anywhere above it
      const r = runIn(dir, dir)
      rmSync(dir, { recursive: true, force: true })
      expect(r.stdout, 'it resolved something with no declaration present').toContain('NOT_FOUND')
    })

    it('service_url reports the failure rather than returning an empty url silently', () => {
      const dir = mkdtempSync(join(tmpdir(), 'no-services-'))
      const r = spawnSync('bash', ['-c',
        `export SCRIPT_DIR=${JSON.stringify(dir)}; . ${JSON.stringify(LIB)}; service_url dashboard; echo "rc=$?"`],
        { cwd: dir, encoding: 'utf8', timeout: 20000 })
      rmSync(dir, { recursive: true, force: true })
      expect(r.stderr + r.stdout).toMatch(/not found|cannot resolve/i)
      expect(r.stdout).toContain('rc=1')
    })
  })
})
