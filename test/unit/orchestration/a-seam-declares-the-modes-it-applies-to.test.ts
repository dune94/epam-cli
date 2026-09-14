/**
 * A SEAM DECLARES THE MODES IT APPLIES TO, AND THE HARNESS JUDGES AGAINST THAT DECLARATION.
 *
 * The £0 greenfield harness judged "every declared seam executed" against all 41 registry seams,
 * and seven cannot run on a greenfield single-codeline project by the pipeline's own guards
 * (runCodeGraphDetective returns [] unless EPAM_BROWNFIELD=1; VCs exist for brownfield only; AC
 * classification and elaboration judge tracker tickets; discovery selects from an estate; the
 * repro writer reproduces a defect; the bridge joins two codelines). The registry declares this
 * per seam (appliesTo) and lib/seams-expected.js derives the set for a project from its config —
 * so an excluded seam is listed with its reason, never dropped by hand. Judged by executing the
 * derivation for every project, and the code's own guard where one is callable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const REG = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const profiles = JSON.parse(readFileSync(REG, 'utf8')).profiles as Record<string, any>;
const { projectModes, expectedSeams } = require(join(ROOT, 'orchestrations/scripts/lib/seams-expected.js'));
const KNOWN = new Set(['brownfield', 'greenfield', 'multi-codeline']);

/** Parse JSON into a tree that keeps every key, duplicates included — JSON.parse drops them. */
function parseWithKeys(text: string): any {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const str = (): string => { let out = ''; i += 1; while (text[i] !== '"') { if (text[i] === '\\') { out += text[i] + text[i + 1]; i += 2; } else { out += text[i]; i += 1; } } i += 1; return out; };
  const value = (): any => {
    ws();
    if (text[i] === '{') {
      i += 1; const children: any[] = []; ws();
      while (text[i] !== '}') { ws(); const key = str(); ws(); i += 1; const v = value(); children.push({ key: { value: key }, value: v }); ws(); if (text[i] === ',') i += 1; ws(); }
      i += 1; return { type: 'Object', children };
    }
    if (text[i] === '[') {
      i += 1; const children: any[] = []; ws();
      while (text[i] !== ']') { children.push(value()); ws(); if (text[i] === ',') i += 1; ws(); }
      i += 1; return { type: 'Array', children };
    }
    if (text[i] === '"') { str(); return { type: 'Scalar' }; }
    while (i < text.length && !/[,}\]]/.test(text[i])) i += 1; return { type: 'Scalar' };
  };
  return value();
}

describe('a seam declares the modes it applies to', () => {
  it('the registry has no duplicate keys — a second declaration silently wins over the first', () => {
    // JSON.parse keeps the LAST of two equal keys, so a duplicate `appliesTo` reads as whichever
    // was written second and the file still parses (2026-09-14: a second appliesTo on
    // ac-elaboration made a declaration nobody could see). Every object in the registry is
    // checked for repeated keys by walking the text, not the parsed value.
    const text = readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8');
    const dups: string[] = [];
    const walk = (node: any, path: string) => {
      if (node.type === 'Object') {
        const seen = new Map<string, number>();
        for (const c of node.children) { const k = c.key.value; seen.set(k, (seen.get(k) || 0) + 1); }
        for (const [k, n] of seen) if (n > 1) dups.push(`${path}/${k} ×${n}`);
        for (const c of node.children) walk(c.value, `${path}/${c.key.value}`);
      } else if (node.type === 'Array') node.children.forEach((c: any, i: number) => walk(c, `${path}[${i}]`));
    };
    walk(parseWithKeys(text), '');
    expect(dups, 'duplicate keys in the registry').toEqual([]);
  });
  it('every appliesTo names known modes only, and is non-empty where present', () => {
    for (const [seam, p] of Object.entries(profiles)) {
      if (p.appliesTo === undefined) continue;
      expect(Array.isArray(p.appliesTo) && p.appliesTo.length, `${seam}.appliesTo`).toBeTruthy();
      for (const m of p.appliesTo) expect(KNOWN.has(m), `${seam}.appliesTo names "${m}"`).toBe(true);
      expect(typeof p._whyAppliesTo, `${seam} states why`).toBe('string');
    }
  });
  it('a seam declaring appliesTo is not expected on a project outside those modes, and is expected inside them', () => {
    const declared = Object.entries(profiles).filter(([, p]) => Array.isArray(p.appliesTo));
    expect(declared.length).toBeGreaterThan(0);
    const gf = expectedSeams(profiles, new Set(['greenfield']));
    const bf = expectedSeams(profiles, new Set(['brownfield', 'multi-codeline']));
    for (const [seam, p] of declared) {
      if (!p.appliesTo.includes('greenfield')) { expect(gf.expected).not.toContain(seam); expect(gf.excluded[seam]).toMatch(/applies to/); }
      expect(bf.expected, `${seam} on a brownfield multi-codeline project`).toContain(seam);
    }
    expect(gf.expected.length + Object.keys(gf.excluded).length).toBe(Object.keys(profiles).length);
  });
  it('the modes of every checked-in project derive from its env, resolved through the registry', () => {
    const dir = join(ROOT, 'orchestrations/projects');
    const { projectEnvFiles } = require(join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js'));
    for (const d of readdirSync(dir)) {
      const files = projectEnvFiles(join(dir, d)); if (!files || !existsSync(files.base)) continue;
      const text = readFileSync(files.base, 'utf8');
      const modes = projectModes(text);
      expect(modes.has(/^EPAM_BROWNFIELD=1$/m.test(text) ? 'brownfield' : 'greenfield'), d).toBe(true);
    }
  });
});

describe("the declaration matches the pipeline's own guard", () => {
  it('the detective investigates nothing unless the run is brownfield', async () => {
    const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
    expect(profiles['code-graph-detective'].appliesTo).toEqual(['brownfield']);
    const saved = process.env.EPAM_BROWNFIELD; process.env.EPAM_BROWNFIELD = '0';
    try {
      // A story with a codeline path that exists: if the guard were absent this would try to run.
      const out = await spec.runCodeGraphDetective({ id: 'X-1', title: 't', codeline: 'x', acceptanceCriteria: ['a'] }, null);
      expect(out).toEqual([]);
    } finally { if (saved === undefined) delete process.env.EPAM_BROWNFIELD; else process.env.EPAM_BROWNFIELD = saved; }
  });
});
