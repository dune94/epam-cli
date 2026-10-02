/**
 * THE COPILOT SET CLIMBS THE CLAUDE LADDERS, ON ITS OWN RUNNER — AND NO OTHER SET MOVES.
 *
 * Operator, 2026-09-27: GitHub Copilot calls must get "proper settings from ladder" with "models same as
 * claude", and "this cannot break existing providers or the pipeline". So the copilot provider set does
 * not copy the claude set's ladders (two copies drift): it names the keys it inherits from that file, and
 * declares its own runner. A set that inherited the claude RUNNER too would make `claude` routable on the
 * copilot set and could be routed there instead — so only the named keys are inherited.
 *
 * Executed through the resolver the pipeline calls (lib/llm-settings-resolve.js) and the routable-provider
 * handler (lib/handlers/ladder-providers.js), under each set.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const RESOLVE = join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js');
const LADDER_PROVIDERS = join(ROOT, 'orchestrations/scripts/lib/handlers/ladder-providers.js');
const SETS = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/provider-sets.json'), 'utf8'));

function underSet(set: string, expr: string) {
  const r = spawnSync(process.execPath, ['-e', `const r=require(${JSON.stringify(RESOLVE)}); process.stdout.write(JSON.stringify(${expr}))`],
    { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set, EPAM_LLM_DEFAULTS_FILE: '' } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

describe('the copilot set', () => {
  it('is declared, and names the credential it authenticates with', () => {
    const c = SETS.sets.copilot;
    expect(c).toBeDefined();
    expect(c.credentials.map((x: { env: string }) => x.env)).toContain('COPILOT_GITHUB_TOKEN');
  });

  it('climbs the claude set\'s ladders except the tiers it prices itself — chains, rungs and model overrides', () => {
    // Operator, 2026-10-01: ladders ideal for cost on GHCP. Copilot bills per token, so the copilot set
    // redeclares the tiers it prices differently (its own `ladders`); every other tier is the claude set's.
    const copilot = underSet('copilot', 'r.resolveLlmSettings()');
    const claude = underSet('claude', 'r.resolveLlmSettings()');
    const own = Object.keys(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../../orchestrations/config/llm-defaults.copilot.json'), 'utf8')).ladders || {});
    expect(Object.keys(copilot.ladders).length).toBeGreaterThan(0);
    expect(Object.keys(copilot.ladders).sort()).toEqual(Object.keys(claude.ladders).sort());
    for (const t of Object.keys(claude.ladders).filter((k) => !own.includes(k))) expect(copilot.ladders[t]).toEqual(claude.ladders[t]);
    for (const t of own) expect(copilot.ladders[t].rungs).toEqual(claude.ladders[t].rungs);
    expect(copilot.ladderTierOrder).toEqual(claude.ladderTierOrder);
    expect(copilot.modelOverrides).toEqual(claude.modelOverrides);
  });

  it('declares the copilot runner and only it — the claude runner is not inherited', () => {
    expect(underSet('copilot', 'r.declaredRunners()')).toEqual(['copilot']);
  });

  it('routes to copilot and nothing else', () => {
    const r = spawnSync(process.execPath, [LADDER_PROVIDERS], { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: 'copilot' } });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['copilot']);
  });

  it('the runner asks the CLI for JSONL, maps the pipeline\'s tools to Copilot\'s, and states what it cannot bind', () => {
    const rn = underSet('copilot', 'r.resolveRunner("copilot")');
    expect(rn.alwaysFlags).toEqual(expect.arrayContaining(['--output-format=json', '--allow-all-tools']));
    expect(rn.toolNames.read_file).toEqual(['view']);
    expect(rn.toolNames.write_file).toEqual(expect.arrayContaining(['create', 'edit']));
    expect(rn.toolNames.search).toEqual(['grep']);
    expect(rn.toolNames.bash).toEqual(['bash']);
  });

  it('its final fallback is served by copilot, on a model the ladders climb', () => {
    const full = underSet('copilot', 'r.readSetFile(r.activeSetFile())');
    expect(full.finalFallback.provider).toBe('copilot');
  });
});

describe('every other set resolves as its own file declares — inheriting only the keys it names', () => {
  // Derived from each set's own settings file, not a list of names: a set that inherits (copilot, and
  // codemie-web since 2026-09-28) must resolve every named key exactly as the file it names does, and
  // declare only its own runners; a set that inherits nothing must resolve exactly as declared.
  const setOfFile = (f: string) => Object.keys(SETS.sets).find((k) => SETS.sets[k].settingsFile === f);
  for (const set of Object.keys(SETS.sets).filter((s) => s !== 'copilot')) {
    const file = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config', SETS.sets[set].settingsFile), 'utf8'));
    if (!file.inheritFrom) {
      it(`${set}: resolves exactly as its own file declares — no inheritance in play`, () => {
        const runners = underSet(set, 'r.declaredRunners()');
        expect(runners).toEqual(Object.keys(file.runners || {}));
        const ladders = underSet(set, 'r.resolveLlmSettings().ladders');
        for (const [tier, def] of Object.entries(file.ladders || {})) expect(ladders[tier]).toMatchObject(def as object);
      });
      continue;
    }
    it(`${set}: inherits exactly the keys it names from ${file.inheritFrom.file}, and declares only its own runner`, () => {
      const source = setOfFile(file.inheritFrom.file);
      expect(source, `no set declares ${file.inheritFrom.file}`).toBeTruthy();
      const mine = underSet(set, 'r.resolveLlmSettings()'); const theirs = underSet(source!, 'r.resolveLlmSettings()');
      expect(file.inheritFrom.keys.length).toBeGreaterThan(0);
      for (const k of file.inheritFrom.keys) expect(mine[k], `${set}.${k}`).toEqual(theirs[k]);
      expect(underSet(set, 'r.declaredRunners()')).toEqual(Object.keys(file.runners || {}));
      const r = spawnSync(process.execPath, [LADDER_PROVIDERS], { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set } });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(Object.keys(file.runners || {}));
    });
  }
});
