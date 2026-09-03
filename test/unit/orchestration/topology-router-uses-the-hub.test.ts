import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, readdirSync, existsSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CHANNEL 5 OF 8. topology-router built its own @anthropic-ai/sdk client and read
// ANTHROPIC_API_KEY itself. Its guard was `if (!apiKey) fall back to the heuristic` — and the
// free-run scrub writes `sk-mock-not-real`, which is TRUTHY. So a scrubbed run sailed past the
// guard and called the vendor anyway; scrubbing only guaranteed a 401, never silence.
const ROUTER = join(process.cwd(), 'orchestrations/scripts/lib/topology-router.js')
// THE HARNESS NAMES NO PROJECT. The seam resolves its model from a ladder, and refuses
// rather than substituting one — correct behaviour, and it needs a project config to read.
// Naming one here would bake a deployment fact into a test, so the harness DISCOVERS the
// first project that declares llm settings and skips loudly if none does.
// topology-router is NOT one of the 39 declared seams, so resolveOrRefuse can never answer
// for it and the module refuses at load — its LLM path has been dead in every run, always
// falling back to the heuristic. That is a separate defect from the channel consolidation.
// These tests SKIP LOUDLY rather than pass vacuously while it stays undeclared.
const PROFILES = join(process.cwd(), 'orchestrations/agents/invocation-profiles.json')
const SEAM_DECLARED = (() => {
  try {
    const j = JSON.parse(readFileSync(PROFILES, 'utf8'))
    return Object.keys(j.profiles || j).includes('topology-router')
  } catch { return false }
})()

// A seam-declared prompt renders from THIS PROJECT's provisioned copy — the template is never
// executed directly. So the harness PROVISIONS one, exactly as the mint would, into a project it
// builds itself. It borrows no real project: naming one would bake a deployment fact into a test.
const TEMPLATE = join(process.cwd(), 'orchestrations/prompts/templates/topology-router.json')

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'toporouter-proj-'))
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  // the provisioned copy IS the template here; specialisation is the mint's job, not this test's
  cpSync(TEMPLATE, join(dir, 'prompts', 'topology-router.json'))
  writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify({}, null, 2))
  return dir
}

const INPUT = JSON.stringify({
  phase: 'core',
  stories: [{ id: 'S-1', effort: 'M', agentRole: 'dev', dependencies: [] }],
})

/**
 * THE LADDER ENV EVERY REAL CALLER ALREADY HAS.
 *
 * The orchestrator calls export_model_ladders before invoking any seam, so EPAM_MODEL_LADDER_*
 * is set in every process a seam runs in. This harness invoked the router with none of it, and
 * the router did exactly the right thing: it refused to substitute a model nothing configured
 * and fell back to the heuristic. So the test reported "the hub was never invoked" against a
 * correctly-refusing router, in a state no run is ever in.
 *
 * Produced by the REAL loader rather than assembled here — a fixture that invents its own
 * preconditions confirms the code instead of checking it.
 */
function ladderEnv(projectDir: string): Record<string, string> {
  // NAMED VARIABLES ONLY — never `env | grep EPAM`. That pattern also matches
  // EPAM_API_KEY_ANTHROPIC/OPENAI/GEMINI and would print live credentials into test output. It
  // is also unreliable here: this system's `grep` is ugrep, which suppressed the whole match set
  // as binary while `printenv` returned the same variables fine. The tier names come from the
  // ladder itself, so nothing below is hardcoded.
  const out = spawnSync('bash', ['-c',
    `. ${JSON.stringify(join(process.cwd(), 'orchestrations/scripts/lib/model-ladders.sh'))}; `
    + `export_model_ladders ${JSON.stringify(join(projectDir, 'llm-settings.json'))} >/dev/null 2>&1; `
    // bash's own prefix expansion lists exactly the ladder variables — no grep, and nothing
    // outside the prefix can be printed, so a credential cannot reach test output.
    + 'for v in "\${!EPAM_MODEL_LADDER@}"; do printf \'%s=%s\\n\' "$v" "\${!v}"; done',
  ], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_PROVIDER_SET: 'mockserver',
           NODE_BIN: process.env.NODE_BIN || process.execPath },
  })
  const env: Record<string, string> = {}
  for (const line of (out.stdout || '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0 && line.slice(i + 1).trim()) env[line.slice(0, i)] = line.slice(i + 1)
  }
  return env
}

function runWithHub(hubBody: string, opts: { provisioned?: boolean } = {}) {
  const provisioned = opts.provisioned !== false
  const projectDir = provisioned ? makeProject() : mkdtempSync(join(tmpdir(), 'toporouter-bare-'))
  const dir = mkdtempSync(join(tmpdir(), 'toporouter-'))
  const hub = join(dir, 'llm-handler.sh')
  const record = join(dir, 'invoked.txt')
  writeFileSync(hub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\ncat > /dev/null\n${hubBody}\n`)
  chmodSync(hub, 0o755)
  const r = spawnSync(process.execPath, [ROUTER], {
    encoding: 'utf8', input: INPUT, timeout: 30000,
    env: {
      ...process.env,
      EPAM_LLM_HUB: hub,
      // a scrubbed key is TRUTHY — the old guard let this through to the vendor
      ANTHROPIC_API_KEY: 'sk-mock-not-real',
      EPAM_ORCHESTRATION_PROVIDER: 'claude',
      EPAM_PROVIDER_SET: 'mockserver',
      EPAM_PROJECT_CONFIG_DIR: projectDir,
      NODE_BIN: process.env.NODE_BIN || process.execPath,
      ...ladderEnv(projectDir),
    },
  })
  const invoked = (() => { try { return readFileSync(record, 'utf8') } catch { return '' } })()
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
  return { ...r, invoked }
}

describe('topology-router routes through the hub', () => {
  it('THE INVARIANT: it reads no vendor credential and builds no vendor client', () => {
    const src = readFileSync(ROUTER, 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/ANTHROPIC_API_KEY|EPAM_API_KEY_ANTHROPIC/)
    expect(code).not.toMatch(/@anthropic-ai\/sdk|new Anthropic/)
  })

  it('EXECUTED: it asks the hub, and reports the hub answer as the LLM source', () => {
    expect(SEAM_DECLARED, 'topology-router must be a declared seam or it can never resolve a model').toBe(true)
    const r = runWithHub(`printf '%s' '{"topology":"sequential","reason":"shared scope"}'`)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.invoked, 'the hub was never invoked').not.toBe('')
    const out = JSON.parse(r.stdout.trim())
    expect(out.topology).toBe('sequential')
    expect(out.source).toBe('llm')
  })

  it('EXECUTED: while the seam is undeclared, it degrades to the heuristic — as it always has', () => {
    const r = runWithHub('exit 7')
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    // Undeclared seam -> refuses to resolve a model -> heuristic. Declared seam -> hub failed
    // -> heuristic. Either way a failure never invents a topology.
    expect(out.source).toBe('heuristic')
    expect(['single', 'parallel', 'sequential']).toContain(out.topology)
  })

  it('an unprovisioned project degrades to the heuristic rather than running a template', () => {
    // prompt-library refuses to fall back to the generic template — a project without a copy is
    // a PROVISIONING defect, and it must surface as one rather than as a silently generic run.
    const r = runWithHub(`printf '%s' '{"topology":"sequential","reason":"x"}'`, { provisioned: false })
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    expect(out.source).toBe('heuristic')
    expect(r.invoked, 'no vendor may be asked when the prompt is missing').toBe('')
  })
})
