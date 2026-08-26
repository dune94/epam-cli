/**
 * A PROVISIONED PROJECT, FOR TESTS THAT MUST RENDER A SEAM PROMPT.
 *
 * A seam-declared prompt renders from THIS PROJECT's copy — prompt-library refuses to execute a
 * template, because a project without a copy is a provisioning defect that must surface as one
 * rather than as a silently generic run. No project in a fresh checkout has generated prompts
 * (the mint produces them agentically), so any harness that renders one gets:
 *
 *   [engine-prompt] '<name>' is a seam-declared prompt ... EPAM_PROJECT_CONFIG_DIR is unset
 *
 * and the test reads as a broken prompt when the prompt is fine and nothing has been minted.
 *
 * The established answer in this repo (see topology-router-uses-the-hub.test.ts) is to provision
 * a TEMP project by copying the template into it: the provisioned copy IS the template here, and
 * specialisation is the mint's job, not a test's. That keeps the assertion pointed at real render
 * behaviour instead of skipping it, and it never asks the PIPELINE to execute a template.
 *
 * What this deliberately does NOT do is invent prompt text. Copying is provisioning; authoring a
 * fixture prompt would assert that the harness's own string renders, which is true of any string.
 */
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const REPO_ROOT = join(__dirname, '../../')
const TEMPLATES = join(REPO_ROOT, 'orchestrations/prompts/templates')

const made: string[] = []

/** Every template name available to provision from, derived — never listed. */
export function templateNames(): string[] {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const { readdirSync } = require('node:fs')
  return readdirSync(TEMPLATES).filter((f: string) => f.endsWith('.json')).map((f: string) => f.slice(0, -5))
}

/**
 * A temp project dir provisioned with the named prompts (all of them when none are named).
 * Returns the dir; set EPAM_PROJECT_CONFIG_DIR to it.
 */
export function provisionProject(names?: string[], extra?: { llmSettings?: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), 'provisioned-project-'))
  made.push(dir)
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  const wanted = names && names.length ? names : templateNames()
  const missing: string[] = []
  for (const n of wanted) {
    const src = join(TEMPLATES, `${n}.json`)
    if (!existsSync(src)) { missing.push(n); continue }
    cpSync(src, join(dir, 'prompts', `${n}.json`))
  }
  if (missing.length) {
    throw new Error(
      `[provisioned-project] no template for: ${missing.join(', ')}. A prompt with no template `
      + 'cannot be provisioned, and inventing one here would assert this file\'s own text.')
  }
  writeFileSync(join(dir, 'llm-settings.json'),
    JSON.stringify(extra?.llmSettings ?? {}, null, 2))
  return dir
}

/** Remove every dir this module created. Call from afterAll. */
export function cleanupProvisioned(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
}
