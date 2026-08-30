/**
 * A STACK IS SELECTED BY EPAM_PROVIDER_SET, AND BY NOTHING ELSE.
 *
 * The operator's standing requirement: claude is the default, and codemie-claude and openrouter
 * hot-swap in with ZERO code changes. That is a statement about the provider SETS — everything a
 * run needs must come from config/llm-defaults.<set>.json, so switching stacks is one environment
 * variable and never an edit.
 *
 * What a set has to answer, or the swap is not real:
 *
 *   a runner       the binary the seam is executed through, with its flags
 *   a ladder       the models a seam climbs, with an opening rung
 *   a provider     one the dispatch table actually accepts
 *   credentials    which keys to remove, and which to leave in place
 *
 * A set missing any of these does not fail at switch time — it falls back to whatever the
 * environment happened to carry, which is how a run launched as `claude` executed on a provider
 * that no longer exists.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const CONFIG = join(REPO, 'orchestrations/config');
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const PROJECT = join(REPO, 'orchestrations/projects/mock3');

/** Every stack the repository ships, discovered rather than listed here. */
const SETS = readdirSync(CONFIG)
  .map((f) => /^llm-defaults\.([a-z0-9-]+)\.json$/.exec(f)?.[1])
  .filter((s): s is string => !!s);

/** What the pipeline resolves for a set, through the API the pipeline itself uses. */
function resolve(set: string, expr: string) {
  const r = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(join(SCRIPTS, 'lib/llm-settings-resolve.js'))});
    const projectConfigDir = ${JSON.stringify(PROJECT)};
    process.stdout.write(JSON.stringify(${expr}));
  `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, EPAM_PROVIDER_SET: set } });
  try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
}

/** The providers the orchestrator's dispatch table will accept. */
function acceptedProviders(): string[] {
  const src = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
  return [...src.matchAll(/^\s{4,}([a-z][a-z0-9-]*)\)\s+CLAUDE_SH=/gm)].map((m) => m[1]);
}

describe('a stack swaps by config alone', () => {
  it('the repository ships the stacks the operator names', () => {
    expect(SETS, 'a stack the operator switches between is missing').toEqual(
      expect.arrayContaining(['claude', 'codemie', 'openrouter']),
    );
  });

  it.each(SETS)('%s: resolves a runner, so a swap does not inherit the previous stack\'s', (set) => {
    const runner = resolve(set, 'm.runnerValues(m.activeSet().name === "codemie" ? "codemie-claude" : "claude", { projectConfigDir })');
    expect(runner, `the ${set} set resolves no runner at all`).toBeTruthy();
    expect(Array.isArray(runner.alwaysFlags), 'flags are not declared').toBe(true);
    expect(runner.env && typeof runner.env === 'object', 'env is not declared').toBe(true);
  }, 60_000);

  it.each(SETS)('%s: declares a ladder with an opening model', (set) => {
    const models = resolve(set, 'm.resolveLlmSettings({projectConfigDir}).ladders');
    expect(models, `the ${set} set declares no ladders`).toBeTruthy();
    const opening = Object.values<any>(models).map((l) => l && l.startModel).filter(Boolean);
    expect(opening.length, `no tier in the ${set} set names a start model, so no seam can begin`)
      .toBeGreaterThan(0);
  }, 60_000);

  it.each(SETS)('%s: routes to a provider the dispatch accepts', (set) => {
    // The failure this exists to stop: a set resolving to a provider the orchestrator rejects, or
    // to one that no longer exists. Either way the run dies at startup or on the first call.
    const r = spawnSync('bash', ['-c', `
      SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
      eval "$(sed -n '/^resolve_primary_provider()/,/^}/p' ${JSON.stringify(join(SCRIPTS, 'llm-handler.sh'))})"
      resolve_primary_provider 2>/dev/null
    `], { encoding: 'utf8', timeout: 60000, env: { ...process.env, EPAM_PROVIDER_SET: set } });
    const provider = (r.stdout || '').trim();
    expect(provider, `the ${set} set resolves no provider at all`).not.toBe('');
    expect(acceptedProviders(),
      `the ${set} set routes to '${provider}', which the orchestrator dispatch does not accept`)
      .toContain(provider);
  }, 60_000);

  it('no stack requires a source edit to select — the sets differ, the code does not', () => {
    // The requirement itself: whatever differs between stacks lives in config. If two sets were
    // identical the switch would be meaningless; if selecting one needed an edit it would not be
    // a switch at all.
    const bodies = SETS.map((s) => readFileSync(join(CONFIG, `llm-defaults.${s}.json`), 'utf8'));
    expect(new Set(bodies).size, 'two stacks are byte-identical, so one of them is not a stack')
      .toBe(SETS.length);
    for (const s of SETS) {
      expect(existsSync(join(CONFIG, `llm-defaults.${s}.json`)),
        `${s} has no config file, so selecting it must mean editing code`).toBe(true);
    }
  });
});
