import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

// PER-MODEL BUDGETS MUST REACH THE SEAM THAT SPENDS THEM.
//
// A model's iteration budget is declared per stack (llm-defaults.<set>.json modelOverrides).
// seam-invocation read it from the PROJECT's llm-settings.json instead — and the 2026-08-25
// migration moved modelOverrides OUT of project files into the set files, with the projects
// left carrying a note saying so.
//
// So iterationMap() returned "" for every project, every seam ran on whatever default the
// provider felt like, and nothing reported it. The declaration existed and reached nothing —
// the same shape as the cost blindness and the plan-fidelity gate.
const REPO = process.cwd()
const { iterationMap } = require(join(REPO, 'orchestrations/scripts/lib/model-settings.js'))
const { seamInvocationEnv } = require(join(REPO, 'orchestrations/scripts/lib/seam-invocation.js'))

function projectDir() { return join(REPO, 'orchestrations/projects/metrolinx') }

function envFor(set: string, seam: string) {
  const prevSet = process.env.EPAM_PROVIDER_SET
  const prevDir = process.env.EPAM_PROJECT_CONFIG_DIR
  process.env.EPAM_PROVIDER_SET = set
  process.env.EPAM_PROJECT_CONFIG_DIR = projectDir()
  try { return seamInvocationEnv(seam, undefined, { sourceEnv: process.env }) || {} }
  finally {
    if (prevSet === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = prevSet
    if (prevDir === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prevDir
  }
}

describe('per-model budgets reach the seam', () => {
  it('THE MIGRATION LEFT THE READER BEHIND: project files declare no modelOverrides', () => {
    const fromProject = iterationMap(join(projectDir(), 'llm-settings.json'))
    expect(String(fromProject || ''), 'a project file still carries modelOverrides — the migration is incomplete').toBe('')
  })

  it('the SET declares them — that is where the reader must look', () => {
    const fromSet = iterationMap(join(REPO, 'orchestrations/config/llm-defaults.openrouter.json'))
    expect(String(fromSet || ''), 'the openrouter set declares no per-model budgets').not.toBe('')
    expect(String(fromSet)).toMatch(/=\d+/)
  })

  it('EXECUTED: a seam on the openrouter stack receives a per-model iteration budget', () => {
    const env: any = envFor('openrouter', 'team-lead-review')
    expect(String(env.EPAM_MODEL || ''), 'no model resolved — the rest proves nothing').not.toBe('')
    expect(String(env.EPAM_MAX_ITERATIONS || ''),
      `the seam got no iteration budget for ${env.EPAM_MODEL}; it would run on a provider default nobody chose`)
      .not.toBe('')
  })

  // EVERY STACK IS BUDGETED — THROUGH ITS OWN DECLARED CHANNEL.
  //
  // The two express the same thing differently, and asserting one spelling would have failed a
  // correctly-budgeted stack: the Claude runner takes TURNS (declared on the ladder rung and
  // exported as CLAUDE_CODE_MAX_TURNS), the OpenRouter path takes ITERATIONS (declared per model
  // and exported as EPAM_MAX_ITERATIONS). What must never happen is a seam with neither — that is
  // a call running on whatever default the provider chose.
  it.each(['claude', 'codemie', 'openrouter'])('EXECUTED: a seam on %s is budgeted', (set) => {
    const env: any = envFor(set, 'team-lead-review')
    expect(String(env.EPAM_MODEL || ''), 'no model resolved — the rest proves nothing').not.toBe('')
    const budget = String(env.EPAM_MAX_ITERATIONS || '') || String(env.CLAUDE_CODE_MAX_TURNS || '')
    expect(budget,
      `${set}/${env.EPAM_MODEL} received NO budget in either spelling — it would run on a `
      + 'provider default nobody chose').not.toBe('')
  })

  it('the set-aware cache: two stacks in ONE process give different models', () => {
    // The ladder cache was keyed by project directory alone, so the first stack resolved in a
    // process became the answer for every later one — asking for `claude` after `openrouter`
    // returned glm-5.3.
    const a: any = envFor('openrouter', 'team-lead-review')
    const b: any = envFor('claude', 'team-lead-review')
    expect(a.EPAM_MODEL).not.toBe(b.EPAM_MODEL)
  })
})
