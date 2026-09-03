/**
 * WHERE LADDERS AND MODEL OVERRIDES LIVE — one answer, for every test that reads them.
 *
 * They used to live in each project's llm-settings.json. The 2026-08-25 migration moved them
 * into config/llm-defaults.<set>.json, because a ladder names MODELS and a model belongs to a
 * STACK: with the declaration in the project, `EPAM_PROVIDER_SET=codemie` changed the provider
 * and left the models behind, and a run pointed at one stack still asked for another's models.
 *
 * The projects now carry only a note saying so. Sixteen tests kept reading the project file and
 * got `undefined` — and production did too, until seam-invocation.js was repointed the same day.
 * A reader left behind by a migration is the defect class this file exists to close.
 *
 * NOTHING IS PINNED HERE. The stack is discovered from what it declares, so adding or renaming a
 * stack needs no edit, and a test that wants a specific one asks for it by name.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_ROOT = join(__dirname, '../../')
const CONFIG_DIR = join(REPO_ROOT, 'orchestrations/config')

/** Every declared stack, newest declaration order irrelevant. */
export function stackNames(): string[] {
  const reg = join(CONFIG_DIR, 'provider-sets.json')
  if (!existsSync(reg)) return []
  return Object.keys(JSON.parse(readFileSync(reg, 'utf8')).sets || {})
}

/** The settings a stack declares: ladders, modelOverrides, runners, finalFallback. */
export function stackSettings(set: string): any {
  const f = join(CONFIG_DIR, `llm-defaults.${set}.json`)
  if (!existsSync(f)) throw new Error(`no settings file for stack '${set}' — ${f}`)
  return JSON.parse(readFileSync(f, 'utf8'))
}

/** The default stack, as the registry declares it. */
export function defaultStack(): string {
  return JSON.parse(readFileSync(join(CONFIG_DIR, 'provider-sets.json'), 'utf8')).defaultSet
}

/**
 * The first stack whose modelOverrides match a predicate — for tests written about a family of
 * models rather than about one stack. Returns null when no stack declares them, so the caller can
 * skip loudly instead of asserting against an empty object.
 */
export function stackDeclaring(pred: (modelKey: string) => boolean): any | null {
  for (const s of stackNames()) {
    let j: any
    try { j = stackSettings(s) } catch { continue }
    if (Object.keys(j.modelOverrides || {}).some((k) => !k.startsWith('$') && pred(k))) return j
  }
  return null
}

/** Ladders for a stack, or the default stack's when none is named. */
export function ladders(set?: string): any {
  return stackSettings(set || defaultStack()).ladders || {}
}

/** Model overrides for a stack, or the default stack's when none is named. */
export function modelOverrides(set?: string): Record<string, any> {
  const mo = stackSettings(set || defaultStack()).modelOverrides || {}
  return Object.fromEntries(Object.entries(mo).filter(([k]) => !k.startsWith('$')))
}
