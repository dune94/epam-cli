/**
 * A PROJECT DECLARES ONLY ITS DIFFERENCES.
 *
 * claude.sh:226 already reads an engine-wide `orchestrations/config/llm-defaults.json`, and its own
 * comment states the intent: "engine-wide defaults, project overrides. Two tiers so a project
 * states only what it changes."
 *
 * That inheritance covers `effortTiers`, `roleOverrides` and `outputTokenFloors` — enumerated key
 * by key — and STOPS THERE. `ladders` and `modelOverrides`, the two largest and most duplicated
 * blocks, were never added. So every project carried a full copy: the same ten model pins existed
 * in metrolinx, mock3 and skyscanner, and removing them on 2026-08-25 meant the same edit four
 * times. Onboarding a project means restating the whole ladder, and a change to the engine's
 * intended defaults reaches nobody.
 *
 * This closes that gap. The rule is the one the file already states: the engine declares a base,
 * a project states only what differs, and the project always wins where both speak.
 *
 * THE FIRST TEST HERE IS THE REGRESSION GUARD. With no defaults declared, every project must
 * resolve byte-identically to today — this change is a mechanism, not a retune.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const settings = require(join(LIB, 'llm-settings-resolve.js'));

/** An engine defaults file and a project file, in a throwaway pair of directories. */
const fixture = (defaults: unknown, project: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-inherit-'));
  const defaultsFile = join(dir, 'llm-defaults.json');
  const projectDir = join(dir, 'proj');
  require('node:fs').mkdirSync(projectDir, { recursive: true });
  writeFileSync(defaultsFile, JSON.stringify(defaults));
  if (project !== undefined) {
    writeFileSync(join(projectDir, 'llm-settings.json'), JSON.stringify(project));
  }
  return { defaultsFile, projectDir };
};

const resolve = (defaults: unknown, project: unknown) => {
  const f = fixture(defaults, project);
  return settings.resolveLlmSettings({ projectConfigDir: f.projectDir, defaultsFile: f.defaultsFile });
};

describe('nothing changes for a project that declares everything', () => {
  it('with NO engine defaults, the project file is returned unchanged', () => {
    const project = {
      ladderTierOrder: ['medium', 'high'],
      ladders: { medium: { startModel: 'm-1', modelLadder: [{ from: 'm-1', to: 'm-2' }] } },
      modelOverrides: { 'm-1': { matchSubstring: 'm-1', maxIterations: 45 } },
    };
    expect(resolve({}, project)).toEqual(project);
  });

  it('every real project resolves identically with the shipped defaults', () => {
    // THE GUARD THAT MATTERS. This is a mechanism change; not one project may move.
    const projects = require('node:fs')
      .readdirSync(join(ROOT, 'orchestrations/projects'))
      .filter((p: string) => require('node:fs')
        .existsSync(join(ROOT, 'orchestrations/projects', p, 'llm-settings.json')));
    expect(projects.length, 'no projects found — this guard would prove nothing').toBeGreaterThan(0);
    for (const p of projects) {
      const dir = join(ROOT, 'orchestrations/projects', p);
      const raw = JSON.parse(readFileSync(join(dir, 'llm-settings.json'), 'utf8'));
      const resolved = settings.resolveLlmSettings({ projectConfigDir: dir });
      expect(resolved.ladders, `${p}: ladders moved`).toEqual(raw.ladders);
      expect(resolved.modelOverrides, `${p}: modelOverrides moved`).toEqual(raw.modelOverrides);
      expect(resolved.ladderTierOrder, `${p}: tier order moved`).toEqual(raw.ladderTierOrder);
    }
  });
});

describe('the engine declares a base a project inherits', () => {
  const DEFAULTS = {
    ladderTierOrder: ['medium', 'high', 'highest'],
    ladders: {
      medium: { startModel: 'base-lo', modelLadder: [{ from: 'base-lo', to: 'base-hi' }] },
      high: { startModel: 'base-hi', modelLadder: [{ from: 'base-hi', to: 'base-top' }] },
    },
    modelOverrides: {
      'base-lo': { matchSubstring: 'base-lo', maxIterations: 45, temperature: 0.2 },
    },
  };

  it('a project that declares nothing inherits the whole base', () => {
    const r = resolve(DEFAULTS, undefined);
    expect(r.ladderTierOrder).toEqual(['medium', 'high', 'highest']);
    expect(r.ladders.medium.startModel).toBe('base-lo');
    expect(r.modelOverrides['base-lo'].maxIterations).toBe(45);
  });

  it('a project overrides ONE tier and inherits the rest', () => {
    const r = resolve(DEFAULTS, { ladders: { medium: { startModel: 'mine' } } });
    expect(r.ladders.medium.startModel, 'the project did not win').toBe('mine');
    expect(r.ladders.medium.modelLadder,
      'overriding startModel silently dropped the inherited chain').toEqual(
      [{ from: 'base-lo', to: 'base-hi' }]);
    expect(r.ladders.high.startModel, 'an untouched tier was lost').toBe('base-hi');
  });

  it('a project overrides ONE model override and inherits the others', () => {
    const r = resolve(
      { ...DEFAULTS, modelOverrides: { a: { maxIterations: 1 }, b: { maxIterations: 2 } } },
      { modelOverrides: { b: { maxIterations: 99 } } },
    );
    expect(r.modelOverrides.a.maxIterations, 'an untouched override was lost').toBe(1);
    expect(r.modelOverrides.b.maxIterations, 'the project did not win').toBe(99);
  });

  it('a project REPLACES a chain rather than merging arrays element-wise', () => {
    // An array is a declaration, not a set of slots. Merging by index would splice a project's
    // two-hop chain into the engine's five-hop one and produce a ladder nobody declared.
    const r = resolve(DEFAULTS, {
      ladders: { medium: { modelLadder: [{ from: 'x', to: 'y' }] } },
    });
    expect(r.ladders.medium.modelLadder).toEqual([{ from: 'x', to: 'y' }]);
  });

  it('a project can add a tier the engine never declared', () => {
    const r = resolve(DEFAULTS, { ladders: { experimental: { startModel: 'e-1' } } });
    expect(r.ladders.experimental.startModel).toBe('e-1');
    expect(r.ladders.high.startModel).toBe('base-hi');
  });

  it('an absent defaults file is not an error — projects work as they always have', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-nodef-'));
    writeFileSync(join(dir, 'llm-settings.json'), JSON.stringify({ ladders: { high: { startModel: 'only' } } }));
    const r = settings.resolveLlmSettings({ projectConfigDir: dir, defaultsFile: '/nonexistent.json' });
    expect(r.ladders.high.startModel).toBe('only');
  });
});

describe('BOTH readers give the same answer — the resolver is wired, not just written', () => {
  /**
   * A resolver nobody calls is the defect this repo keeps finding: a library with a test and no
   * caller LOOKS covered. The ladders reach a run through two readers — lib/seam-invocation.js for
   * the seam layer and lib/model-ladders.sh for everything shell — and if only one consults the
   * base, a project inheriting a chain gets one there and none here.
   */
  it('seam-invocation resolves through llm-settings-resolve, not the raw file', () => {
    const src = readFileSync(join(LIB, 'seam-invocation.js'), 'utf8');
    expect(src, 'the seam layer still reads llm-settings.json directly, so it cannot inherit')
      .toMatch(/llm-settings-resolve/);
  });

  it('model-ladders.sh resolves through it too', () => {
    const src = readFileSync(join(LIB, 'model-ladders.sh'), 'utf8');
    expect(src, 'the shell reader still reads the project file raw').toMatch(/llm-settings-resolve/);
  });

  it('and the real project resolves to the same start models through the JS path', () => {
    // Behaviour, not wiring: what a seam is actually handed must not have moved.
    const dir = join(ROOT, 'orchestrations/projects/metrolinx');
    const raw = JSON.parse(readFileSync(join(dir, 'llm-settings.json'), 'utf8'));
    const r = settings.resolveLlmSettings({ projectConfigDir: dir });
    for (const tier of Object.keys(raw.ladders || {})) {
      expect(r.ladders[tier].startModel, `${tier} start model moved`)
        .toBe(raw.ladders[tier].startModel);
    }
  });
});
