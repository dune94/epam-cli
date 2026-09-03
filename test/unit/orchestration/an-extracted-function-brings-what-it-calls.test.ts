import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// A HARNESS THAT EXTRACTS A FUNCTION MUST EXTRACT WHAT THAT FUNCTION CALLS.
//
// Lifting a shell function into a fixture and running it is the established pattern here, and it
// is a good one — it tests real behaviour. But it silently rots: when the function later gains a
// call to a helper, the harness still extracts only what it always did, the helper is undefined,
// and the failure surfaces as the FUNCTION misbehaving.
//
// That is not hypothetical. verify_story_deliverables gained _resolved_baseline_ref in 2f2bb37;
// four harnesses kept extracting two functions, the resolver was undefined, its
// `git rev-parse --verify` guard failed, and the whole unchanged-detection block was skipped. One
// suite reported "10/10 incorrectly passed" — the harness failing open while the gate was correct.
// run_named_import_check moved its python to lib/handlers/ and eleven cases failed for a missing
// SCRIPT_DIR rather than anything about imports.
//
// So: for every function a harness extracts, every OTHER extractable function it calls must be
// extracted too. Derived from the scripts and the harnesses — nothing listed here.
const REPO = process.cwd()
const SCRIPTS = join(REPO, 'orchestrations/scripts')
const TESTS = join(REPO, 'test/unit/orchestration')

/** Every shell function the engine defines, and its body. */
function engineFunctions(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'test') walk(p); continue }
      if (!e.name.endsWith('.sh')) continue
      const src = readFileSync(p, 'utf8')
      for (const m of src.matchAll(/^([a-z_][a-zA-Z0-9_]*)\(\)\s*\{/gm)) {
        const start = m.index!
        const end = src.indexOf('\n}', start)
        if (end > start) {
          // CODE ONLY. A helper NAMED in a comment is not a helper CALLED, and counting those
          // buries the real gaps in noise — the same convention the project-fact guard uses.
          const body = src.slice(start, end)
            .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
          out.set(m[1], body)
        }
      }
    }
  }
  walk(SCRIPTS)
  return out
}

const FUNCS = engineFunctions()

type Gap = { file: string; fn: string; missing: string[] }

function gaps(): Gap[] {
  const found: Gap[] = []
  for (const name of readdirSync(TESTS)) {
    if (!name.endsWith('.test.ts')) continue
    const src = readFileSync(join(TESTS, name), 'utf8')
    const extracted = [...src.matchAll(/extractFunctionBody\(\s*['"]([a-zA-Z0-9_]+)['"]/g)].map(m => m[1])
    if (!extracted.length) continue
    const have = new Set(extracted)
    for (const fn of new Set(extracted)) {
      const body = FUNCS.get(fn)
      if (!body) continue
      // helpers this function calls that the harness could have extracted but did not
      const missing = [...FUNCS.keys()].filter((h) =>
        h !== fn && !have.has(h)
        && new RegExp(`(^|[^a-zA-Z0-9_."'\\\`])${h}(\\s|$|"|'|\\))`, 'm').test(body)
        // a harness may legitimately STUB a collaborator instead of extracting it
        && !new RegExp(`${h}\\(\\)\\s*\\{`).test(src))
      if (missing.length) found.push({ file: name, fn, missing })
    }
  }
  return found
}

describe('an extracted function brings what it calls', () => {
  it('the engine and the harnesses are both readable — otherwise this is vacuous', () => {
    expect(FUNCS.size, 'no engine shell functions found').toBeGreaterThan(50)
  })

  // A RATCHET, NOT A WALL. Fifty-one harnesses predate this rule, and failing every one of them
  // today would mean disabling the guard by tomorrow. What must not happen is the number GROWING:
  // each new gap is a harness that will one day report the function misbehaving when the harness
  // is what is wrong.
  //
  // Five were fixed the day this was written (four verify_story_deliverables harnesses missing
  // _resolved_baseline_ref, and named-import-check missing SCRIPT_DIR). The baseline is what
  // remained after that.
  const GAP_BASELINE = 51

  it('THE RATCHET: harnesses missing a helper may only decrease', () => {
    const found = gaps()
    expect(found.length,
      `harnesses running a function with an undefined helper went UP (was ${GAP_BASELINE}, now `
      + `${found.length}). The failure surfaces as the FUNCTION misbehaving — that is how `
      + '"10/10 incorrectly passed" was reported while the gate was correct. Extract the helper, '
      + 'or stub it deliberately in the harness.').toBeLessThanOrEqual(GAP_BASELINE)
  })

  it('the four harnesses fixed today stay fixed', () => {
    const found = gaps()
    const regressed = found.filter((g) => /verify-(story-)?deliverables/.test(g.file)
      && g.missing.includes('_resolved_baseline_ref'))
    expect(regressed.map(g => g.file),
      'a verify_story_deliverables harness lost its baseline resolver again').toEqual([])
  })
})
