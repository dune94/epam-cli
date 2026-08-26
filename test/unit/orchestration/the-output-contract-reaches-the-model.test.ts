/**
 * A SCHEMA THAT BINDS AT THE PROVIDER REACHES NOTHING ON A ONE-SHOT RUNNER.
 *
 * Five seams declare their output shape as a TOOL_* definition and bind it with
 * EPAM_RESPONSE_SCHEMA. That variable is read in exactly ONE place — src/agent/AgentRunner.ts,
 * the ReAct loop reached through the `epam run` arm. On the claude and codemie stacks the runner
 * is `claude --print`, which the hub never hands a schema, so the binding is inert and the prompt
 * is the only channel the contract has.
 *
 * Live 2026-08-26: roster-review returned three correct, evidenced findings as markdown; the
 * extractor found no <ROSTER_REVIEW> tag; mint-agents-step refused to continue on an unreviewed
 * roster and the run aborted. PROJECT_AGENTS failed identically in the same run. The schema's own
 * description says "Do not answer in prose" — and the model never saw it.
 *
 * The contract is rendered FROM the tool definition, so these assert the rendering tracks the
 * schema rather than restating a shape that can drift from it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../..')
const RUNNER = join(ROOT, 'orchestrations/scripts/spec-mode-runner.js')
const src = readFileSync(RUNNER, 'utf8')

/** The real renderer, lifted from the module. */
function renderer(): (t: unknown, tag: string) => string {
  const i = src.indexOf('function outputContractFor')
  expect(i, 'outputContractFor is gone — the contract no longer reaches the prompt').toBeGreaterThan(-1)
  const j = src.indexOf('\n}\n', i) + 3
  // eslint-disable-next-line no-eval
  return eval(`(${src.slice(i, j)})`)
}

/** Every TOOL_* definition the runner declares, read from the source. */
function toolDefs(): Array<{ name: string; def: any }> {
  const out: Array<{ name: string; def: any }> = []
  for (const m of src.matchAll(/const (TOOL_[A-Z_]+) = \{/g)) {
    const i = m.index as number
    const j = src.indexOf('\n};', i) + 3
    try {
      // eslint-disable-next-line no-eval
      out.push({ name: m[1], def: eval(`(${src.slice(i + `const ${m[1]} = `.length, j).replace(/;\s*$/, '')})`) })
    } catch { /* a definition this test cannot evaluate is covered by the count check below */ }
  }
  return out
}

describe('the declared output contract reaches the model', () => {
  it('every seam that binds EPAM_RESPONSE_SCHEMA is a seam whose prompt carries the contract', () => {
    const bound = [...src.matchAll(/EPAM_RESPONSE_SCHEMA: schemaEnv\((TOOL_[A-Z_]+)\)/g)].map((m) => m[1])
    expect(bound.length, 'no seam binds a schema — this guard has lost its subject').toBeGreaterThan(0)
    // runAgentForJson is the single chokepoint every one of them goes through.
    expect(src, 'runAgentForJson no longer appends the contract, so a one-shot runner gets no shape')
      .toMatch(/prompt = `\$\{prompt\}\$\{outputContractFor\(toolDef, tag\)\}`/)
  })

  it('the contract names the tag, and says prose outside it is discarded', () => {
    const out = renderer()({ name: 'x', description: 'd', parameters: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } } }, 'MY_TAG')
    expect(out).toContain('<MY_TAG>')
    expect(out).toContain('</MY_TAG>')
    expect(out, 'nothing tells the model that prose is thrown away').toMatch(/DISCARDED/)
  })

  it('required and optional are taken from the schema that governs each object', () => {
    // The parent's `required` was used for array-item fields too, marking five mandatory
    // evidence fields "(optional)" — permission to omit exactly what a finding is worthless
    // without.
    const def = {
      name: 'x', description: 'd',
      parameters: {
        type: 'object', required: ['verdict'],
        properties: {
          verdict: { type: 'string' },
          findings: { type: 'array', items: { type: 'object', required: ['must'], properties: { must: { type: 'string', description: 'm' }, may: { type: 'string', description: 'o' } } } },
        },
      },
    }
    const out = renderer()(def, 'T')
    const chunk = (f: string) => out.slice(out.indexOf(`"${f}":`), out.indexOf('\n', out.indexOf('//', out.indexOf(`"${f}":`))))
    expect(chunk('must'), 'a REQUIRED item field is marked optional').not.toMatch(/\(optional\)/)
    expect(chunk('may'), 'an optional item field is not marked optional').toMatch(/\(optional\)/)
  })

  it('enums are stated, so the model cannot invent a verdict the parser rejects', () => {
    // Live 2026-08-24: a reviewer answered "warn", a value the enum does not permit.
    const out = renderer()({ name: 'x', description: 'd', parameters: { type: 'object', required: ['v'], properties: { v: { type: 'string', enum: ['sound', 'defects_found'] } } } }, 'T')
    expect(out).toContain('"sound"')
    expect(out).toContain('"defects_found"')
  })

  it('the rendering derives from the real definitions, not a copy', () => {
    const defs = toolDefs()
    expect(defs.length, 'no TOOL_* definitions could be read').toBeGreaterThan(0)
    const render = renderer()
    for (const { name, def } of defs) {
      const out = render(def, 'TAG')
      expect(out.length, `${name} renders an empty contract`).toBeGreaterThan(0)
      for (const key of Object.keys((def.parameters && def.parameters.properties) || {})) {
        expect(out, `${name}: the contract omits declared field ${key}`).toContain(`"${key}"`)
      }
    }
  })
})
