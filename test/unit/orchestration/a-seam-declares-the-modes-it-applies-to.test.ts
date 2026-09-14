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

describe('a seam declares the modes it applies to', () => {
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
