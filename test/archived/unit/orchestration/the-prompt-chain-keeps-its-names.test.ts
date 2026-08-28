/**
 * THE PROMPT CHAIN KEEPS ITS NAMES.
 *
 *   template (id)  ->  project prompt (same id, + derivedFromSha256)  ->  seam(s)
 *
 * Every hop is an EXPLICIT id. No hop is allowed to be a string transformation of the previous
 * one, because that is how a name gets lost: the registry called a gate `qa-gate:sast` and the
 * template layer called the same thing `qa-sast-sentinel`, and the only thing joining them was
 * a human noticing the resemblance. Nothing failed. The mapping simply did not exist, and any
 * report of "which prompt does this seam use" had to be re-derived by reading call sites — which
 * is how a wrong pairing (perf-sentinel to the fuzz-weaver seam) got produced by a proximity
 * scan of the shell script.
 *
 * Operator, 2026-08-16: "you cannot lose names ... the template library prompt should have an id
 * and map to the project prompt which then maps to seams."
 *
 * So the template DECLARES which seams it serves, and these tests hold the declaration to the
 * two things around it: the registry on one side, the provisioned project copy on the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

type Doc = { id?: string; seams?: string[]; consumer?: string; body?: string; bodies?: unknown };

function templates(): Array<{ file: string; doc: Doc }> {
  return readdirSync(TEMPLATES)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, doc: JSON.parse(readFileSync(join(TEMPLATES, file), 'utf8')) as Doc }));
}

const seams = (): string[] => Object.keys(JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles || {});

describe('the chain is real', () => {
  it('there are templates and seams to check — otherwise everything below is vacuous', () => {
    expect(templates().length).toBeGreaterThan(20);
    expect(seams().length).toBeGreaterThan(20);
  });
});

describe('hop 1 — a template owns its id', () => {
  it('every template declares an id, and it matches its filename', () => {
    // The filename is how every renderer resolves a template. An id that disagrees with it means
    // two names for one prompt, and the loader silently prefers the filename.
    for (const { file, doc } of templates()) {
      expect(doc.id, `${file} declares no id, so nothing downstream can refer to it by name`).toBeTruthy();
      expect(doc.id, `${file} and its declared id are two different names for one prompt`)
        .toBe(file.replace(/\.json$/, ''));
    }
  });
});

describe('hop 2 — a template declares the seams it serves', () => {
  it('every template says which seams it serves, even when the answer is none', () => {
    // `seams: []` with consumer 'engine' is a declaration. An ABSENT field is not — it cannot be
    // told apart from one nobody has filled in yet, which is the state this test ends.
    for (const { file, doc } of templates()) {
      expect(Array.isArray(doc.seams), `${file} does not declare its seams`).toBe(true);
      if (!doc.seams!.length) {
        expect(doc.consumer, `${file} serves no seam but does not say who renders it instead`)
          .toBeTruthy();
      }
    }
  });

  it('every seam a template names is a seam the registry actually declares', () => {
    const known = new Set(seams());
    const bad: string[] = [];
    for (const { file, doc } of templates()) {
      for (const s of doc.seams || []) if (!known.has(s)) bad.push(`${file} -> ${s}`);
    }
    expect(bad, `a prompt points at a seam that does not exist:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every AGENT-FACING seam has at least one prompt that serves it', () => {
    // A seam with no prompt is an agent the pipeline can configure but cannot instruct.
    const served = new Set(templates().flatMap(({ doc }) => doc.seams || []));
    const orphans = seams().filter((s) => !served.has(s));
    expect(
      orphans,
      `these seams have a ladder, an effort and tool grants, but no prompt in the template ` +
      `layer — so whatever instructs them is still embedded somewhere:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no seam is joined to its prompt by transforming a name', () => {
    // THE ACTUAL REGRESSION GUARD. If every seam happened to be served by a template whose id
    // equals the seam name, this whole mechanism would be indistinguishable from the implicit
    // name-matching it replaces — and the first prompt to need a different name would silently
    // lose its link again. At least one declared pair must differ, and by construction several
    // do: qa-gate:sast is served by qa-sast-sentinel.
    const pairs = templates().flatMap(({ doc }) => (doc.seams || []).map((s) => [doc.id!, s]));
    const renamed = pairs.filter(([id, seam]) => id !== seam);
    expect(renamed.length, 'every prompt id equals its seam name, so the declaration is untested')
      .toBeGreaterThan(0);
  });
});

describe('hop 3 — a provisioned project copy carries the identity forward', () => {
  const projects = () => {
    const base = join(ROOT, 'orchestrations/projects');
    return readdirSync(base)
      .map((p) => join(base, p, 'prompts'))
      .filter((d) => existsSync(d));
  };

  it('at least one project has a provisioned library — otherwise this proves nothing', () => {
    expect(projects().length, 'no project has prompts, so hop 3 is untested').toBeGreaterThan(0);
  });

  it('every project prompt keeps the template id and the seams it was minted from', () => {
    for (const dir of projects()) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const tplPath = join(TEMPLATES, file);
        if (!existsSync(tplPath)) continue;  // a project may hold prompts of its own
        const tpl = JSON.parse(readFileSync(tplPath, 'utf8')) as Doc;
        const cp = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Doc;
        expect(cp.id, `${dir}/${file} lost its id, so it maps back to no template`).toBe(tpl.id);
        expect(cp.seams, `${dir}/${file} lost its seam mapping, so the agent that runs at that ` +
          `seam has no way to find this prompt`).toEqual(tpl.seams);
      }
    }
  });
});
