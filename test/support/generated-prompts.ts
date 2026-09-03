/**
 * HAS THE MINT RUN? — one answer, for every test that needs a generated prompt.
 *
 * Project prompts are GENERATED agentically at mint time from the immutable templates, and only
 * the generated copy is ever executed. A checkout that has not run the mint therefore has none,
 * and a test that requires one cannot pass — not because anything is broken, but because a
 * PRECONDITION is absent.
 *
 * Reported as failures, that absence is indistinguishable from a defect: 117 failures in a single
 * file were one missing directory, and they buried 14 real template leaks in the same file.
 *
 * So tests SKIP LOUDLY instead. Absence is a state, never a silent pass — `describeGenerated`
 * always registers a case reporting what was found, so a reader can tell "verified" from
 * "not yet run" without inspecting the tree.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(__dirname, '../../')

/** The generated prompts a project currently has. Empty means the mint has not run for it. */
export function generatedPrompts(project: string): string[] {
  try {
    return readdirSync(join(REPO_ROOT, 'orchestrations/projects', project, 'prompts'))
      .filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

/** Every project that has any generated prompt at all. */
export function projectsWithGeneratedPrompts(): string[] {
  const dir = join(REPO_ROOT, 'orchestrations/projects')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((p) => generatedPrompts(p).length > 0)
}

/**
 * True when NO project has generated prompts — i.e. the mint has not run in this checkout.
 * Use with `it.skipIf(mintHasNotRun())` so the case is reported as skipped, not failed.
 */
export function mintHasNotRun(): boolean {
  return projectsWithGeneratedPrompts().length === 0
}

/** A one-line reason a reader can act on, for the skip message. */
export function whySkipped(): string {
  return 'no project has generated prompts — the mint has not run in this checkout, and a project '
    + 'prompt cannot be produced by a test (it is generated agentically from the templates)'
}
