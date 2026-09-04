/**
 * EVERY VALUE A CALL SITE SUPPLIES MUST HAVE SOMEWHERE TO GO.
 *
 * Live 2026-09-04, pipeline-tests-19:
 *
 *   [prompt-library] 'code-graph-detective' was given values it does not use: __STORY_ACS__.
 *   That evidence is being DROPPED — the prompt has no placeholder for it.
 *
 * The detective is what decides WHICH code a story is about. It was handed the story's acceptance
 * criteria — the statement of what the story must satisfy — and the prompt had no slot for them,
 * so they went nowhere. The detective then reasoned about the codebase without them.
 *
 * prompt-library detects this and warns, deliberately not fatally: a project prompt is generated,
 * may lag the template, and cannot be corrected from the render site, so throwing would take out
 * the whole seam over one dropped block. That trade-off is right AT RUNTIME. It is not a reason
 * for the mismatch to survive in the repository, where the template CAN be corrected — and a
 * warning on stderr in a 30,000-line run log is indistinguishable from silence. It went unnoticed
 * for at least two runs.
 *
 * So the check belongs here, where it is cheap and total: for every call site that names a
 * template id and supplies __PLACEHOLDER__ keys, the template must declare each one.
 *
 * DERIVED, NEVER LISTED. Call sites are discovered by scanning for the two render entry points and
 * reading the keys out of the object literal that follows. Nothing is enumerated, so a call site
 * added tomorrow is checked tomorrow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const TEMPLATES = join(REPO, 'orchestrations/prompts/templates');

/** Every placeholder a template can accept, across all of its bodies. */
function acceptedBy(id: string): Set<string> | null {
  const file = join(TEMPLATES, `${id}.json`);
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const text = [
    typeof doc.body === 'string' ? doc.body : '',
    ...(doc.bodies && typeof doc.bodies === 'object'
      ? Object.values(doc.bodies).filter((b) => typeof b === 'string') as string[]
      : []),
  ].join('\n');
  const found = new Set<string>(text.match(/__[A-Z0-9_]+__/g) || []);
  // A declared-but-unused placeholder is a different defect; what matters here is what the
  // template can ACCEPT, which is the union of what it declares and what its bodies use.
  for (const p of (Array.isArray(doc.placeholders) ? doc.placeholders : [])) found.add(p);
  return found;
}

/**
 * Call sites, found in the pipeline's own sources: a render entry point, a quoted template id,
 * then an object literal whose __KEYS__ are the values supplied.
 */
function callSites(): Array<{ file: string; line: number; id: string; supplied: string[] }> {
  const files = execFileSync('git',
    ['ls-files', 'orchestrations/scripts/*.js', 'orchestrations/scripts/**/*.js'],
    { cwd: REPO, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);

  const out: Array<{ file: string; line: number; id: string; supplied: string[] }> = [];
  const entry = /(?:renderEngineTemplate|buildPrompt)\(\s*\n?\s*['"]([a-z0-9-]+)['"]/g;

  for (const rel of files) {
    const src = readFileSync(join(REPO, rel), 'utf8');
    for (const m of src.matchAll(entry)) {
      const id = m[1];
      // The object literal that follows, to its matching close brace.
      const from = src.indexOf('{', m.index! + m[0].length);
      if (from < 0) continue;
      let depth = 0; let to = from;
      for (; to < src.length; to++) {
        if (src[to] === '{') depth++;
        else if (src[to] === '}') { depth--; if (depth === 0) break; }
      }
      let body = src.slice(from, to + 1);

      // A VALUE MAY ITSELF BE A NESTED RENDER, and its keys belong to the NESTED template.
      //
      //   __DOC_SECTION__: renderEngineTemplate('guard-vocabulary-documentation',
      //                        { __DOC_BLOCK__: docBlock }),
      //
      // Counting __DOC_BLOCK__ against the OUTER template reported three false violations on the
      // first run of this check. The nested call is matched independently by the same scan and is
      // checked against its own template, so blanking it here loses nothing.
      for (;;) {
        const n = /(?:renderEngineTemplate|buildPrompt)\(\s*['"][a-z0-9-]+['"]/.exec(body);
        if (!n) break;
        const nFrom = body.indexOf('{', n.index + n[0].length);
        if (nFrom < 0) { body = body.slice(0, n.index) + body.slice(n.index + n[0].length); continue; }
        let d = 0; let nTo = nFrom;
        for (; nTo < body.length; nTo++) {
          if (body[nTo] === '{') d++;
          else if (body[nTo] === '}') { d--; if (d === 0) break; }
        }
        body = body.slice(0, n.index) + body.slice(nTo + 1);
      }

      // Keys only: `__X__:` at the start of a property, never a mention inside a string.
      const supplied = [...new Set((body.match(/(^|[\s{,])(__[A-Z0-9_]+__)\s*:/g) || [])
        .map((s) => s.replace(/[\s{,:]/g, '')))];
      if (!supplied.length) continue;
      out.push({ file: rel, line: src.slice(0, m.index).split('\n').length, id, supplied });
    }
  }
  return out;
}

const SITES = callSites().filter((s) => acceptedBy(s.id) !== null);

describe('no evidence is assembled and then dropped', () => {
  it('call sites were actually found — otherwise every case below is vacuous', () => {
    expect(SITES.length,
      'no template call site was parsed; the scan has drifted from the sources')
      .toBeGreaterThan(10);
  });

  it('and they name real templates', () => {
    expect(new Set(SITES.map((s) => s.id)).size).toBeGreaterThan(5);
  });

  it.each(SITES.map((s) => ({ where: `${s.file}:${s.line}`, id: s.id, supplied: s.supplied })))(
    '$where supplies only what $id can take', ({ id, supplied, where }) => {
      const accepted = acceptedBy(id)!;
      const orphans = supplied.filter((p) => !accepted.has(p));
      expect(orphans, [
        `${where} supplies ${orphans.join(', ')} to '${id}', which has no placeholder for it.`,
        'The value is computed, handed over, and DROPPED — prompt-library warns on stderr and',
        'carries on, because at runtime a generated prompt cannot be corrected. Here it can:',
        'add the placeholder to the template, or stop computing the value.',
        '',
        'This is how the code-graph-detective — the step that decides WHICH code a story is',
        "about — reasoned without the story's acceptance criteria on 2026-09-04.",
      ].join('\n')).toEqual([]);
    });
});
