/**
 * A PROMPT REGENERATED FROM UNCHANGED INPUTS IS MONEY SPENT FOR NOTHING.
 *
 * The pre-run reset deletes <project>/prompts every run, so every prompt was rebuilt from
 * immutable templates that had not moved. Measured on mock3 run 9: 29 prompts, $5.48 — 89% of the
 * run's cost, before a single story was touched.
 *
 * The obstacle is __MINTED_ROLES__. The mint invents new role names every run, so a digest over
 * all inputs never matches. But of run 9's 31 generated prompts only FOUR embedded a minted role
 * name — whether a template's OUTPUT depends on the roster is a fact about that template, learned
 * by looking at what it produced.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '../../..')
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js'), 'utf8')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The real helpers, lifted from the builder. */
function helpers(mintedRolesText?: string) {
  const i = SRC.indexOf('const cacheDir =')
  expect(i, 'the reuse cache is gone — every run pays to regenerate').toBeGreaterThan(-1)
  const end = SRC.indexOf('for (const id of generated) {', i)
  const body = SRC.slice(i, end)
  const outDir = join(mkdtempSync(join(tmpdir(), 'ppb-')), 'prompts'); dirs.push(outDir)
  // eslint-disable-next-line no-eval
  // THE HARNESS MUST MODEL THE MODULE'S OWN SCOPE. This lifts a slice of the file and evaluates
  // it against a fixed parameter list, so anything the real code calls from module scope has to be
  // passed in — otherwise a helper the module genuinely has reads as "not defined" here and the
  // test fails for a reason that does not exist in production. rolesIdentity is taken from the
  // module's exports rather than restated, so the two cannot drift.
  // eslint-disable-next-line no-eval
  return eval(`(function(fs, path, crypto, outDir, generatorBody, projectContext, codelineContext, mintedRoles, rolesIdentity){
    ${body}; return { cacheDir, sha, baseDigest, rolesDigest, usesRoles, cacheRead, cacheWrite, outDir };
  })`)(require('node:fs'), require('node:path'), require('node:crypto'),
    outDir, 'GEN', 'PROJECT', 'CODELINE',
    // The mint's real shape: `- <name> [<kind>] — <rationale>`, not a bare comma list.
    mintedRolesText
      ?? '- fare-schedule-engineer [implementer] — owns the schedule\n- mocka-fare-detective [investigator] — investigates fares',
    // eslint-disable-next-line global-require
    require(join(ROOT, 'orchestrations/scripts/lib/project-prompt-builder.js')).rolesIdentity)
}

describe('prompts are not regenerated from unchanged inputs', () => {
  it('THE WIRING: a reworded rationale produces the SAME rolesDigest', () => {
    // rolesIdentity working in isolation proves nothing about the KEY. This asserts the digest the
    // cache is actually keyed on, lifted from the builder itself.
    //
    // Live 2026-09-04: 39 cache entries, 0 hits, 28 of them roster-dependent — every one rebuilt
    // at model prices each run because the mint rewords its own rationale between runs.
    const same = '- a-engineer [implementer] — owns the form';
    const reworded = '- a-engineer [implementer] — responsible for the form, including validation';
    expect(helpers(same).rolesDigest, [
      'the cache key still changes when only the prose changes, so a second run against the same',
      'codeline regenerates every roster-dependent prompt for a difference no prompt can observe.',
    ].join('\n')).toBe(helpers(reworded).rolesDigest);
  });

  it('THE WIRING still invalidates: a different role set changes the rolesDigest', () => {
    const one = '- a-engineer [implementer] — owns the form';
    const two = `${one}\n- b-engineer [implementer] — owns payments`;
    expect(helpers(one).rolesDigest,
      'an added agent left the key unchanged; a prompt could name it')
      .not.toBe(helpers(two).rolesDigest);
  });

  it('the reuse check runs BEFORE any model call, and is skipped on a miss', () => {
    const loop = SRC.slice(SRC.indexOf('for (const id of generated) {'))
    const reuse = loop.indexOf('reused ${id}')
    const call = loop.indexOf('await runText(')
    expect(reuse, 'nothing reuses a cached prompt').toBeGreaterThan(-1)
    expect(reuse, 'the reuse check happens after the model has already been paid')
      .toBeLessThan(call)
  })

  it('an identical template hits the cache; a changed one does not', () => {
    const h = helpers()
    const tpl = { id: 't', body: 'B', placeholders: [] }
    expect(h.baseDigest(tpl)).toBe(h.baseDigest({ id: 't', body: 'B', placeholders: [] }))
    expect(h.baseDigest(tpl)).not.toBe(h.baseDigest({ id: 't', body: 'CHANGED', placeholders: [] }))
  })

  it('THE KEY DISTINCTION: a prompt that names a minted role is roster-dependent; one that does not is not', () => {
    const h = helpers()
    const roles = 'fare-schedule-engineer, mocka-fare-detective'
    expect(h.usesRoles({ body: 'assign work to fare-schedule-engineer' }, roles),
      'a prompt naming a minted role was treated as roster-independent and would be reused stale').toBe(true)
    expect(h.usesRoles({ body: 'review the change against its acceptance criteria' }, roles),
      'a roster-independent prompt was treated as dependent and would be regenerated every run').toBe(false)
  })

  it('a round trip returns the same document', () => {
    const h = helpers()
    const entry = { base: 'b', roles: h.rolesDigest, usesRoles: false, doc: { id: 'x', body: 'hello' } }
    h.cacheWrite('x', entry)
    expect(h.cacheRead('x')).toEqual(entry)
    expect(h.cacheRead('never-written'), 'a missing entry must read as a miss, not throw').toBeNull()
  })

  it('the cache lives outside prompts/, which the reset deletes', () => {
    const h = helpers()
    expect(h.cacheDir).not.toContain(`${join('', 'prompts')}${require('node:path').sep}`)
    expect(h.cacheDir.endsWith('.prompt-cache')).toBe(true)
  })
})
