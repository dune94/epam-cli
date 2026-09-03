/**
 * A RUNNER'S SETTINGS ARE DECLARED, AND THE ENGINE PASSES WHATEVER IS DECLARED.
 *
 * The two execution paths were asymmetric. `ai-run` receives EPAM_MAX_ITERATIONS,
 * EPAM_AUTO_COMPRESS_AT, EPAM_MAX_OUTPUT_TOKENS and EPAM_MAX_TOOL_CALLS as environment
 * (claude.sh:10219-10223). The external-CLI path receives only --model, a dead --max-turns
 * and permissions (claude.sh:10273/10302). So on that path every budget was INERT — which is
 * how one seam ran 1,486 turns in 44 minutes with nothing able to stop it.
 *
 * The fix is a MECHANISM, not a list: a runner declares `env` and `flags` maps, and the engine
 * passes what they name. No CLAUDE_CODE_* name, model id, turn count or ttl in any script;
 * adding a knob is a config edit. That is what makes this testable with a FIXTURE runner —
 * the mechanism must work for a runner the engine has never heard of.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const MOD = join(ROOT, 'orchestrations/scripts/lib/llm-settings-resolve.js');
function fresh() { delete require.cache[require.resolve(MOD)]; return require(MOD); }

const saved = { ...process.env };
const tmps: string[] = [];
afterEach(() => { process.env = { ...saved }; for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A registry declaring one set whose settings file declares a FIXTURE runner. */
function scaffold(runners: any) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-')); tmps.push(dir);
  const cfg = join(dir, 'config'); mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'provider-sets.json'), JSON.stringify({
    defaultSet: 'only',
    sets: { only: { settingsFile: 'stack.only.json', projectEnvSuffix: 'only' } },
    projectEnv: { base: 'config.env', overlay: 'config.{set}.env' },
  }));
  writeFileSync(join(cfg, 'llm-defaults.json'), JSON.stringify({}));
  writeFileSync(join(cfg, 'stack.only.json'), JSON.stringify({
    ladders: { medium: { startModel: 'FIX-1', modelLadder: [{ from: 'FIX-1', to: 'FIX-2' }] } },
    ladderTierOrder: ['medium'],
    modelOverrides: { fix: { matchOn: 'model', matchSubstring: 'FIX', maxIterations: 42, maxOutputTokens: 4242 } },
    runners,
  }));
  const project = join(dir, 'proj'); mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'llm-settings.json'), JSON.stringify({}));
  process.env.EPAM_PROVIDER_SETS_FILE = join(cfg, 'provider-sets.json');
  return { dir, project };
}

describe('a runner gets what it declares', () => {
  it('resolveRunner returns the declared env and flag maps for a runner it has never seen', () => {
    const { project } = scaffold({
      'a-fixture-runner': {
        alwaysFlags: ['-s'],
        env: { SOME_TOOL_MAX_TURNS: 'maxIterations', SOME_TOOL_MAX_OUT: 'maxOutputTokens' },
        flags: { '--timeout': 'timeoutSeconds' },
      },
    });
    const r = fresh().resolveRunner('a-fixture-runner', { projectConfigDir: project });
    expect(r, 'a declared runner must resolve').toBeTruthy();
    expect(r.env).toEqual({ SOME_TOOL_MAX_TURNS: 'maxIterations', SOME_TOOL_MAX_OUT: 'maxOutputTokens' });
    expect(r.flags).toEqual({ '--timeout': 'timeoutSeconds' });
    expect(r.alwaysFlags).toEqual(['-s']);
  });

  it('an UNDECLARED runner resolves to null — the other path stays untouched', () => {
    const { project } = scaffold({ 'a-fixture-runner': { env: {} } });
    expect(fresh().resolveRunner('some-other-runner', { projectConfigDir: project })).toBeNull();
  });

  it('with NO runners block at all, every runner resolves to null', () => {
    const { project } = scaffold(undefined);
    expect(fresh().resolveRunner('a-fixture-runner', { projectConfigDir: project })).toBeNull();
  });

  it('a declaration naming a setting NOTHING defines is reported, not silently dropped', () => {
    // A map entry pointing at a setting no model declares is a silent no-op — the exact
    // shape of the defect this whole layering removes. It must be visible.
    const { project } = scaffold({
      'a-fixture-runner': { env: { SOME_TOOL_X: 'aSettingNobodyDeclares' } },
    });
    const r = fresh().resolveRunner('a-fixture-runner', { projectConfigDir: project });
    const names = fresh().runnerSettingNames(r);
    expect(names).toContain('aSettingNobodyDeclares');
  });

  it('NO runner name or knob name appears as a literal in any engine script', () => {
    const dir = join(ROOT, 'orchestrations/scripts');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'test') walk(f); }
        else if (/\.(sh|js)$/.test(e.name)) files.push(f);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join('\n');
      // THE BUDGET KNOBS ONLY. Not every CLAUDE_CODE_* name belongs in a declaration:
      // sandbox-invoke.sh suppresses telemetry and non-essential traffic, and cpa-inference.js
      // deletes an inherited ENTRYPOINT. Those are environment hygiene — they carry no value a
      // project could declare, and forbidding them would be a rule nobody could satisfy.
      //
      // What must NEVER be spelled in a script is a knob whose VALUE comes from settings: a
      // turn cap, an output cap, a compaction window, a cache ttl, an effort level, a thinking
      // budget. Those are exactly the ones that were inert on the CLI path.
      const BUDGET_KNOB = /\b(CLAUDE_CODE_MAX_[A-Z_]+|CLAUDE_CODE_AUTO_COMPACT[A-Z_]*|CLAUDE_CODE_PROMPT_CACHE_TTL|CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL|CLAUDE_CODE_EFFORT_LEVEL|MAX_THINKING_TOKENS)\b/;
      const hit = code.match(BUDGET_KNOB);
      if (hit) offenders.push(`${f.replace(ROOT + '/', '')}: names the budget knob ${hit[0]}`);
    }
    expect(offenders, 'a knob name belongs in the declaration, never in a script').toEqual([]);
  });
});
