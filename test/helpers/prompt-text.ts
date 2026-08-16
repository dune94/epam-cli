/**
 * THE PROMPT TEXT, WHEREVER IT NOW LIVES.
 *
 * Many suites were written when a prompt was a template literal inside the script that sent
 * it, so they sliced the enclosing function out of the source and asserted on the slice. That
 * was always a proxy — it passes on a comment and on a dead branch — but it was the only
 * artifact there was.
 *
 * Since every prompt moved into orchestrations/prompts/templates (operator rule, 2026-08-15)
 * the slice contains the render call and none of the wording, so those assertions compare
 * against text that is no longer there. They fail for a reason that has nothing to do with
 * the behaviour they guard.
 *
 * This gives them the real text back. `region()` returns the code slice CONCATENATED with the
 * bodies of the templates that code renders, so a structural assertion still reads the code
 * and a wording assertion still reads the wording — each against the artifact that actually
 * carries it. Nothing is inferred: the caller names the templates.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES = join(__dirname, '../../orchestrations/prompts/templates');

/** One template's prompt text. Multi-body templates are joined, so no variant is invisible. */
export function templateBody(id: string): string {
  const doc = JSON.parse(readFileSync(join(TEMPLATES, `${id}.json`), 'utf8'));
  if (doc.bodies && typeof doc.bodies === 'object') {
    return Object.values(doc.bodies).map(String).join('\n');
  }
  const body = String(doc.body ?? '');
  if (!body.trim()) throw new Error(`[prompt-text] template '${id}' has no body — an empty one makes every assertion vacuous`);
  return body;
}

/** Code plus the prompts that code sends: the whole surface an assertion may be about. */
export function region(code: string, ...templateIds: string[]): string {
  return [code, ...templateIds.map(templateBody)].join('\n');
}
