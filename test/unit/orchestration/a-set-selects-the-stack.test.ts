/**
 * A PROVIDER SET SELECTS THE WHOLE STACK, AND AN UNKNOWN ONE STOPS THE RUN.
 *
 * Hot swap (C0): when one provider's tokens run out mid-programme, the other must be back on
 * the air in SECONDS — one env var, no build, no test run, no git.
 *
 * The dangerous failure is not a crash, it is a FALL-THROUGH. A typo'd set name that quietly
 * resolves to the default would run a whole programme on the wrong stack while every log line
 * looks configured. That is the same shape as the missing-tier fail-open seam-invocation.js
 * documents, and it must not be repeated one layer up.
 *
 * Layering: engine base (set-INDEPENDENT budgets) -> the SET (which models) -> the project
 * (its differences). Swapping replaces only the middle layer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOD = join(__dirname, '../../../orchestrations/scripts/lib/llm-settings-resolve.js');
function fresh() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

const saved = { ...process.env };
const tmps: string[] = [];
afterEach(() => {
  process.env = { ...saved };
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway config dir holding a registry, a base, and per-set files. */
function scaffold(): { dir: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sets-'));
  tmps.push(dir);
  const cfg = join(dir, 'config'); mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'provider-sets.json'), JSON.stringify({
    defaultSet: 'alpha',
    sets: {
      alpha: { settingsFile: 'stack.alpha.json', projectEnvSuffix: 'alpha' },
      beta:  { settingsFile: 'stack.beta.json',  projectEnvSuffix: 'beta'  },
    },
  }));
  writeFileSync(join(cfg, 'llm-defaults.json'), JSON.stringify({ effortTiers: { low: { maxIterations: 6 } } }));
  writeFileSync(join(cfg, 'stack.alpha.json'), JSON.stringify({
    ladders: { medium: { startModel: 'A-1', modelLadder: [{ from: 'A-1', to: 'A-2' }] } },
    ladderTierOrder: ['medium'],
  }));
  writeFileSync(join(cfg, 'stack.beta.json'), JSON.stringify({
    ladders: { medium: { startModel: 'B-1', modelLadder: [{ from: 'B-1', to: 'B-2' }] } },
    ladderTierOrder: ['medium'],
  }));
  const project = join(dir, 'proj'); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'llm-settings.json'), JSON.stringify({}));
  process.env.EPAM_PROVIDER_SETS_FILE = join(cfg, 'provider-sets.json');
  return { dir, project };
}

describe('a set selects the stack', () => {
  it('unset EPAM_PROVIDER_SET resolves the DECLARED default set', () => {
    const { project } = scaffold();
    delete process.env.EPAM_PROVIDER_SET;
    const r = fresh().resolveLlmSettings({ projectConfigDir: project });
    expect(r.ladders.medium.startModel).toBe('A-1');
  });

  it('naming a set selects that stack — this is the hot swap', () => {
    const { project } = scaffold();
    process.env.EPAM_PROVIDER_SET = 'beta';
    const r = fresh().resolveLlmSettings({ projectConfigDir: project });
    expect(r.ladders.medium.startModel).toBe('B-1');
  });

  it('the swap ROUND-TRIPS: back to the default is byte-identical', () => {
    const { project } = scaffold();
    delete process.env.EPAM_PROVIDER_SET;
    const before = JSON.stringify(fresh().resolveLlmSettings({ projectConfigDir: project }));
    process.env.EPAM_PROVIDER_SET = 'beta';
    fresh().resolveLlmSettings({ projectConfigDir: project });
    delete process.env.EPAM_PROVIDER_SET;
    const after = JSON.stringify(fresh().resolveLlmSettings({ projectConfigDir: project }));
    expect(after).toBe(before);
  });

  it('an UNKNOWN set THROWS and names the declared sets — never falls through', () => {
    const { project } = scaffold();
    process.env.EPAM_PROVIDER_SET = 'gamma';
    let msg = '';
    try { fresh().resolveLlmSettings({ projectConfigDir: project }); }
    catch (e: any) { msg = String(e.message || e); }
    expect(msg, 'an unknown set must not resolve silently').toMatch(/gamma/);
    expect(msg).toMatch(/alpha/);
    expect(msg).toMatch(/beta/);
  });

  it('a set whose settings file is MISSING throws — a half-swap is refused', () => {
    const { dir, project } = scaffold();
    rmSync(join(dir, 'config', 'stack.beta.json'));
    process.env.EPAM_PROVIDER_SET = 'beta';
    let msg = '';
    try { fresh().resolveLlmSettings({ projectConfigDir: project }); }
    catch (e: any) { msg = String(e.message || e); }
    expect(msg).toMatch(/stack\.beta\.json/);
  });

  it('the project still wins over its set', () => {
    const { dir, project } = scaffold();
    writeFileSync(join(project, 'llm-settings.json'), JSON.stringify({
      ladders: { medium: { startModel: 'PROJECT-OWN' } },
    }));
    process.env.EPAM_PROVIDER_SET = 'beta';
    const r = fresh().resolveLlmSettings({ projectConfigDir: project });
    expect(r.ladders.medium.startModel).toBe('PROJECT-OWN');
    // and it keeps the chain it never mentioned
    expect(r.ladders.medium.modelLadder).toEqual([{ from: 'B-1', to: 'B-2' }]);
  });

  it('an explicit defaultsFile still outranks the set — the operator escape hatch survives', () => {
    const { dir, project } = scaffold();
    process.env.EPAM_PROVIDER_SET = 'beta';
    const r = fresh().resolveLlmSettings({
      projectConfigDir: project,
      defaultsFile: join(dir, 'config', 'stack.alpha.json'),
    });
    expect(r.ladders.medium.startModel).toBe('A-1');
  });
});
