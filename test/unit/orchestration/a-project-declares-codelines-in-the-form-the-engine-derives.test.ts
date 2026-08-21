/**
 * A CODELINE NAME IS A PRIMARY KEY, AND EVERY PLACE THAT WRITES ONE MUST WRITE THE SAME FORM.
 *
 * The engine derives a codeline's identity from the repository directory: decoration prefixes and
 * the domain suffix come off, so `next.gotransit.com`, `azure.gotransit.com` and
 * `react.gotransit.com` all resolve to `gotransit`. That derived name is what lands in
 * project.outputDirs, and the lane loop selects on it by EXACT STRING EQUALITY:
 *
 *     if [ "${_e%%:*}" = "$_sel" ]; then _sel_entries+=("$_e"); break; fi
 *
 * So a project that writes the raw directory name in its config or its stories matches nothing.
 * That is not a silent degradation — the selection empties and the run stops with "No
 * codeline/worktree entries found in PRD" — but it stops at launch, after the operator has
 * committed to a run.
 *
 * Found on a project whose repositories are named `mock-a` and `mock-b`: no decoration, no domain
 * suffix, so the derivation's only effect was removing the hyphen. Every name the estate that
 * shaped this rule actually uses is a single word, so the separator case had never shown.
 *
 * This walks every project in the repository. It names none of them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const PROJECTS = join(ROOT, 'orchestrations/projects');
const { deriveCodelineName } = require(join(ROOT, 'orchestrations/scripts/lib/codeline-name.js'));

const projectDirs = () => readdirSync(PROJECTS)
  .map((n) => join(PROJECTS, n))
  .filter((p) => statSync(p).isDirectory());

/**
 * The run's declared scope, as the launcher now reads it: project.outputDirs in the PRD.
 *
 * This used to read EPAM_ONLY_CODELINES out of config.env — an operator restating, by hand,
 * a fact resolve-codeline-scope.sh already writes into the PRD for every project. That
 * variable is deleted; the requirement it was tested for is not. A project's declared
 * codeline names must still be in the form the engine derives, or the lane loop matches
 * nothing and the run stops at launch.
 */
function declaredScope(dir: string): string[] {
  const names: string[] = [];
  for (const f of ['prd.json', 'prd.canonical.json']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      for (const d of (j?.project?.outputDirs ?? [])) {
        if (typeof d?.codeline === 'string' && d.codeline) names.push(d.codeline);
      }
    } catch { /* a malformed PRD is another test's subject */ }
  }
  return [...new Set(names)];
}

/** Every codeline any story in a project's PRDs claims to touch. */
function storyCodelines(dir: string): { file: string; names: string[] }[] {
  const out: { file: string; names: string[] }[] = [];
  for (const f of ['prd.json', 'prd.canonical.json']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const prd = JSON.parse(readFileSync(p, 'utf8'));
      const names = [...new Set((prd.stories || []).flatMap((s: { codelines?: string[] }) => s.codelines || []))] as string[];
      if (names.length) out.push({ file: `${dir.split('/').pop()}/${f}`, names });
    } catch { /* a malformed PRD is another test's problem */ }
  }
  return out;
}

describe('a project declares codelines in the form the engine derives', () => {
  it('finds projects to check — it is not passing on an empty list', () => {
    expect(projectDirs().length, 'no projects found at all').toBeGreaterThan(0);
  });

  it('every EPAM_ONLY_CODELINES entry is already in derived form', () => {
    const wrong: string[] = [];
    for (const dir of projectDirs()) {
      for (const name of declaredScope(dir)) {
        const derived = deriveCodelineName(name);
        if (derived !== name) {
          wrong.push(`${dir.split('/').pop()}/config.env: "${name}" — the engine derives "${derived}"`);
        }
      }
    }
    expect(wrong,
      'a scope bound that is not in derived form matches no outputDir, and the run stops at launch '
      + `with "No codeline/worktree entries found in PRD":\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every story codeline is already in derived form', () => {
    const wrong: string[] = [];
    for (const dir of projectDirs()) {
      for (const { file, names } of storyCodelines(dir)) {
        for (const name of names) {
          const derived = deriveCodelineName(name);
          if (derived !== name) wrong.push(`${file}: "${name}" — the engine derives "${derived}"`);
        }
      }
    }
    expect(wrong,
      'a story naming a codeline in raw form addresses a lane that does not exist, so its work is '
      + `never delivered:\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('a project that declares a scope declares one its own stories can reach', () => {
    // The two halves must agree with each other, not merely with the derivation. A scope naming a
    // codeline no story touches runs a lane with nothing to do; a story outside the scope is work
    // the run silently will not deliver.
    const wrong: string[] = [];
    for (const dir of projectDirs()) {
      const scope = declaredScope(dir);
      if (!scope.length) continue;                          // no bound declared: all codelines
      const named = new Set(storyCodelines(dir).flatMap((s) => s.names));
      if (!named.size) continue;                            // stories carry no codelines
      for (const s of scope) {
        if (!named.has(s)) wrong.push(`${dir.split('/').pop()}: scope names "${s}", no story touches it`);
      }
      for (const n of named) {
        if (!scope.includes(n)) wrong.push(`${dir.split('/').pop()}: a story touches "${n}", the scope excludes it`);
      }
    }
    expect(wrong, `scope and stories disagree:\n  ${wrong.join('\n  ')}`).toEqual([]);
  });
});
