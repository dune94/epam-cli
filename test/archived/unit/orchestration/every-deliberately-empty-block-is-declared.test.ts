/**
 * A BLOCK THE CODE DELIBERATELY LEAVES EMPTY MUST SAY SO IN ITS TEMPLATE.
 *
 * Three runs died on one class. Each time I declared the placeholders that run had exposed and each
 * time the next run found another:
 *   run 20260827T125654Z  spec-agent-openspec  10 blocks
 *   run 20260827T151832Z  prd-change-reviewer-spec  __SPLIT_NOTE__
 * Fixing instances instead of the class is what made this recur, so this test refuses the class.
 *
 * THE DISCRIMINATOR, and it is the whole point — not every empty value may be declared:
 *
 *   DELIBERATE   `cond ? <text> : ''`   the author WROTE the empty branch. Absence is a real state:
 *                                       no split, no prior gaps, no forced retry on attempt one.
 *   DEFENSIVE    `x || ''`              a lookup that may fail. Empty is NOT a real state, and
 *                                       declaring it would hide the exact defect the renderer
 *                                       exists to catch — a roster reviewer once received blank
 *                                       briefs, reported them "entirely empty" and blocked twice.
 *
 * So this asserts only the deliberate set is declared, and separately that the defensive set is
 * NOT — because a blanket sweep would silence the guard rather than satisfy it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const TEMPLATES = join(REPO_ROOT, 'orchestrations/prompts/templates');
const SCRIPTS = join(REPO_ROOT, 'orchestrations/scripts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { placeholdersIn } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

function allJs(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (/node_modules|\.venv/.test(p)) continue;
    if (statSync(p).isDirectory()) allJs(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}
const SRC = allJs(SCRIPTS).map((f) => readFileSync(f, 'utf8')).join('\n');

const deliberate = (rhs: string) => /\?[\s\S]{0,400}?:\s*(''|""|``)/.test(rhs);
const defensive = (rhs: string) => /\|\|\s*(''|""|``)/.test(rhs);

/** How a call site supplies this placeholder: deliberate, defensive, or neither. */
function supplyKind(expr: string): string | null {
  const e = expr.trim().replace(/,$/, '');
  if (deliberate(e)) return 'deliberate';
  if (defensive(e)) return 'defensive';
  const id = e.match(/^([A-Za-z_$][\w$]*)$/);
  if (!id) return null;
  const decl = new RegExp(`(?:const|let|var)\\s+${id[1]}\\s*=([\\s\\S]{0,500}?);`, 'g');
  let m: RegExpExecArray | null; let saw: string | null = null;
  while ((m = decl.exec(SRC))) {
    if (deliberate(m[1])) return 'deliberate';
    if (defensive(m[1])) saw = 'defensive';
  }
  return saw;
}

function scan() {
  const undeclaredDeliberate: string[] = [];
  const declaredDefensive: string[] = [];
  for (const f of readdirSync(TEMPLATES)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/\.json$/, '');
    const j = JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
    const body = typeof j.body === 'string'
      ? j.body
      : Object.values(j.bodies || {}).filter((b) => typeof b === 'string').join('\n');
    const declared = new Set<string>(j.mayBeEmpty || []);
    for (const ph of placeholdersIn(body)) {
      const re = new RegExp(`${ph}\\s*:\\s*([^,\\n]{0,140})`, 'g');
      // EVERY call site must agree. One deliberate branch among several defensive lookups is NOT
      // a licence to declare: the template would then tolerate a failed lookup at the other sites,
      // which is the blank-brief defect the renderer exists to catch. __STORY_DESCRIPTION__ is
      // exactly that shape — one ternary, many `String(story.description || '')` — and declaring
      // it would silence the guard for all of them.
      let m: RegExpExecArray | null;
      const kinds = new Set<string>();
      while ((m = re.exec(SRC))) { const k = supplyKind(m[1]); if (k) kinds.add(k); }
      const kind = (kinds.has('deliberate') && !kinds.has('defensive')) ? 'deliberate'
        : (kinds.has('defensive') ? 'defensive' : null);
      if (kind === 'deliberate' && !declared.has(ph)) undeclaredDeliberate.push(`${id}: ${ph}`);
      if (kind === 'defensive' && declared.has(ph)) declaredDefensive.push(`${id}: ${ph}`);
    }
  }
  return { undeclaredDeliberate, declaredDefensive };
}

describe('every deliberately-empty block is declared, and no defensive one is', () => {
  it('the scan sees real templates and real call sites — otherwise it asserts nothing', () => {
    expect(readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(10);
    expect(SRC.length).toBeGreaterThan(10000);
  });

  it('REPRODUCES three runs: no template leaves a deliberately-empty block undeclared', () => {
    const { undeclaredDeliberate } = scan();
    expect(undeclaredDeliberate,
      'a call site writes an empty branch for this placeholder and the template does not declare '
      + 'it — the renderer WILL refuse mid-run, with no model involved and no retry able to help')
      .toEqual([]);
  });

  it('no DEFENSIVE placeholder has been declared — that would silence the guard', () => {
    const { declaredDefensive } = scan();
    expect(declaredDefensive,
      'this placeholder is supplied by a lookup that may fail, so empty means BROKEN, not absent. '
      + 'Declaring it hides the failure the renderer exists to surface.')
      .toEqual([]);
  });
});
