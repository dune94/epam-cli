/**
 * THE SET DECIDES THE MODELS. EVERY PROJECT. BOTH WAYS.
 *
 * Measured 2026-08-25: with EPAM_PROVIDER_SET=codemie, metrolinx switched its gate provider to
 * codemie-claude and STILL asked for MiniMax-M3 — a provider that cannot serve that model. The
 * cause was that each project declared its own `ladders`, and project overrides set. The swap
 * changed the provider and left the models behind, which is worse than not swapping: it looks
 * configured and cannot run.
 *
 * A ladder names MODELS, and models belong to a stack. So the stack declares them and every
 * project inherits. Swapping a set swaps the models, for every project, in both directions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const MOD = join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js');
const PROJECTS = join(ROOT, 'orchestrations/projects');
function fresh() { delete require.cache[require.resolve(MOD)]; return require(MOD); }
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const projects = readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

function modelsUnder(set: string, project: string): string[] {
  process.env.EPAM_PROVIDER_SET = set;
  const r = fresh().resolveLlmSettings({ projectConfigDir: join(PROJECTS, project) });
  const out = new Set<string>();
  for (const v of Object.values<any>(r.ladders || {})) {
    if (v.startModel) out.add(v.startModel);
    for (const h of v.modelLadder || []) { out.add(h.from); out.add(h.to); }
  }
  return [...out];
}

describe('the set decides the models', () => {
  it('there are projects to check — otherwise this suite is vacuous', () => {
    expect(projects.length).toBeGreaterThan(1);
  });

  it('no project declares ladders of its own — a project cannot know the stack', () => {
    for (const p of projects) {
      const f = join(PROJECTS, p, 'llm-settings.json');
      if (!existsSync(f)) continue;
      const j = JSON.parse(readFileSync(f, 'utf8'));
      expect(j.ladders, `${p} declares ladders, which would override the set`).toBeUndefined();
    }
  });

  for (const p of projects) {
    it(`${p}: on codemie EVERY model is Claude`, () => {
      const models = modelsUnder('codemie', p);
      expect(models.length, `${p} resolved NO ladder — worse than the wrong one`).toBeGreaterThan(0);
      expect(models.filter((m) => !/^claude-/.test(m)),
        `${p} would ask codemie-claude for a model it cannot serve`).toEqual([]);
    });

    it(`${p}: on openrouter NO model is Claude`, () => {
      const models = modelsUnder('openrouter', p);
      expect(models.length, `${p} resolved NO ladder on openrouter`).toBeGreaterThan(0);
      expect(models.filter((m) => /^claude-/.test(m)),
        `${p} would ask the openrouter stack for a Claude model`).toEqual([]);
    });
  }

  it('the swap ROUND-TRIPS: codemie -> openrouter -> codemie is byte-identical', () => {
    const p = projects[0];
    const before = JSON.stringify(modelsUnder('codemie', p));
    modelsUnder('openrouter', p);
    expect(JSON.stringify(modelsUnder('codemie', p))).toBe(before);
  });
});
