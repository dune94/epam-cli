import { existsSync, readFileSync } from 'node:fs';

/**
 * THE ENGINE EMITS CODES AND DATA. IT DOES NOT WRITE ENGLISH.
 *
 * Every agent-facing message in the tools was a sentence composed in engine code — the dedupe
 * notice, both scope-guard refusals, the loop-protection intervention. None of them named a
 * language or a file, which is why they survived review: "no stack facts" was treated as
 * satisfying the no-hardcoding rule. The rule is broader. Prose in the engine cannot be changed
 * per project, cannot be translated, cannot be tuned when a model reacts badly to a phrasing, and
 * drifts the moment a second call site says the same thing differently — which is exactly how one
 * rule came to be written twice, nine lines apart, in the same script.
 *
 * It also matters more than style here. A dedupe notice that said "call read_file again with
 * force: true" was emitted by a live writer as literal TEXT rather than as a tool call; it looped
 * on that instruction until the attempt died having written nothing. The wording IS behaviour.
 *
 * THE CONTRACT
 *   - A tool reports {code, ...data}. The code is a closed vocabulary the pipeline owns.
 *   - Wording comes from a project-owned catalog: {"<code>": "text with {placeholders}"}.
 *   - With NO catalog the engine emits the structured form. It never falls back to a built-in
 *     sentence — a fallback sentence is the hardcoding with a branch in front of it.
 *
 * The structured form is deliberately not readable English. If it looks bare in a run, the answer
 * is to give the project a catalog, not to add a default here.
 */

const CATALOG_ENV = 'EPAM_AGENT_MESSAGE_CATALOG';

/**
 * Read the catalog fresh each call rather than caching.
 *
 * Cost is a file read on a path that is usually unset, and the alternative is a process that
 * cannot pick up an operator's edit without a restart — the same staleness that made the pricing
 * table wrong for months while nobody could see it.
 */
function catalog(): Record<string, string> | null {
  const path = process.env[CATALOG_ENV];
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : null;
  } catch {
    // Unreadable catalog degrades to the structured form. NOT to a built-in sentence: a broken
    // catalog must not be able to change what the engine is willing to say.
    return null;
  }
}

/** `key=value` pairs, stable order, no prose. */
function structured(code: string, data: Record<string, unknown>): string {
  const parts = Object.keys(data)
    .sort()
    .filter((k) => data[k] !== undefined && data[k] !== null)
    .map((k) => `${k}=${String(data[k])}`);
  return parts.length ? `${code} ${parts.join(' ')}` : code;
}

/**
 * Render an agent-facing message for a code.
 *
 * A placeholder with no matching datum is left VISIBLE rather than blanked: a message that
 * quietly loses a value reads as complete while being wrong, and the reader has no way to tell.
 */
export function renderAgentMessage(code: string, data: Record<string, unknown> = {}): string {
  const template = catalog()?.[code];
  if (typeof template !== 'string' || template === '') return structured(code, data);
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    (key in data && data[key] !== undefined && data[key] !== null) ? String(data[key]) : whole);
}
