/**
 * THE PLANNING TURN RAN WITH THE WRITER'S SAMPLING, AND SKIPPED THE STRONGEST TIER ENTIRELY.
 *
 * Two defects, both introduced by hardcoding:
 *
 * 1. `if [ "$_tier" = "high" ]` gated the automatic planner. Adding the `highest` tier therefore
 *    REMOVED its planning turn — the chain that escalates furthest planned the least, silently.
 *    A tier list is configuration; a literal in the engine turns every new tier into a defect.
 *
 * 2. The planning turn inherited EPAM_TEMPERATURE / EPAM_REASONING_EFFORT from the writer.
 *    Vendor guidance for all three live models disagrees sharply on EXECUTION sampling — MiniMax
 *    M3 wants 0.1-0.2 for code precision, GLM-5.2 wants 0.85-1.0 to exploit its MoE — but agrees
 *    that PLANNING wants determinism and structure. Sharing one value made the per-model
 *    execution profiles meaningless for the plan, and pushed planning toward whatever the
 *    writer's model happened to need.
 *
 * Both are now config (`planning.autoPlannerTiers`, `planning.temperature/topP/reasoningEffort`).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// LADDERS AND MODEL OVERRIDES MOVED TO THE STACK. The 2026-08-25 migration took them out of each
// project's llm-settings.json and into config/llm-defaults.<set>.json — a ladder names MODELS and
// a model belongs to a STACK. This file read the project copy, which now carries only a note
// saying so, so every lookup came back empty. See test/support/llm-settings.ts.
import { stackSettings, defaultStack } from '../../support/llm-settings'

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const CFG = stackSettings(defaultStack());
const TIERS: string[] = Object.keys(CFG.ladders);
const PLANNED: string[] = CFG.planning.autoPlannerTiers;

/** Executes the real tier gate from resolve_planner_settings. */
function getsPlanner(tier: string): boolean {
  const i = SRC.indexOf('    # Which tiers get an automatic planner is CONFIG.');
  expect(i, 'the auto-planner gate moved — re-anchor this test').toBeGreaterThan(-1);
  const end = SRC.indexOf('if [ "$_auto_ok" = "1" ]; then', i);
  // `local _auto_ok=0 _pt` becomes a malformed command once `local` is stripped, leaving
  // _auto_ok unset for the NEGATIVE cases — which under `set -u` aborts instead of answering.
  // Initialised here so the harness reproduces the real function's declaration.
  const block = SRC.slice(i, end).replace(/\blocal /g, '').replace(/^\s*_auto_ok=0 _pt\s*$/m, '');
  const out = execFileSync('bash', ['-c',
    `set -u
     _tier=${JSON.stringify(tier)}
     _auto_ok=0
     _pt=""
     export EPAM_AUTO_PLANNER_TIERS=${JSON.stringify(PLANNED.join('|'))}
${block}
     printf '%s' "$_auto_ok"`], { encoding: 'utf8' });
  return out.trim() === '1';
}

describe('DEFECT 1: every tier configured for planning gets a planner', () => {
  it('each configured tier is honoured', () => {
    for (const t of PLANNED) {
      expect(getsPlanner(t), `tier '${t}' is listed for planning but got none`).toBe(true);
    }
  });

  it('THE DEFECT: the highest tier is not skipped', () => {
    expect(
      getsPlanner('highest'),
      'the gate was hardcoded to "high", so the strongest chain planned the least',
    ).toBe(true);
  });

  it('a tier NOT listed does not get one', () => {
    const unplanned = TIERS.filter((t) => !PLANNED.includes(t));
    for (const t of unplanned) expect(getsPlanner(t)).toBe(false);
  });

  it('an unknown tier does not get one', () => {
    expect(getsPlanner('not-a-tier')).toBe(false);
  });

  it('the tier list is not hardcoded in the engine', () => {
    const i = SRC.indexOf('resolve_planner_settings() {');
    const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
    expect(
      /if \[ "\$_tier" = "high" \]; then/.test(body),
      'the hardcoded tier is back — the next tier added loses its planner silently',
    ).toBe(false);
    expect(body).toContain('EPAM_AUTO_PLANNER_TIERS');
  });
});

describe('DEFECT 2: the planning turn uses PLANNING sampling', () => {
  const invocation = () => {
    const i = SRC.indexOf('# PLANNING SAMPLING, not the writer\'s.');
    expect(i, 'the planner invocation moved — re-anchor this test').toBeGreaterThan(-1);
    return SRC.slice(i, i + 2600);
  };

  it('temperature, top_p and effort are all overridden for the plan', () => {
    const inv = invocation();
    expect(inv).toContain('EPAM_PLANNING_TEMPERATURE');
    expect(inv).toContain('EPAM_PLANNING_TOP_P');
    expect(inv).toContain('EPAM_PLANNING_EFFORT');
  });

  it('they are applied only when configured — an unset knob leaves the default alone', () => {
    // Each is guarded by `[ -n "${VAR:-}" ]`, so a project that configures no planning sampling
    // keeps whatever it had. The earlier `${VAR:+FOO=bar}` assignment-prefix form was REMOVED:
    // assignments are recognised at parse time, so a word produced by expansion becomes the
    // command name and the invocation silently produced nothing at all.
    const inv = invocation();
    for (const v of ['EPAM_PLANNING_TEMPERATURE', 'EPAM_PLANNING_TOP_P', 'EPAM_PLANNING_EFFORT']) {
      expect(inv, `${v} is applied unconditionally`).toContain(`[ -n "\${${v}:-}" ]`);
    }
    expect(
      /\$\{EPAM_PLANNING_[A-Z_]+:\+/.test(inv),
      'the assignment-prefix form is back — it silently breaks the invocation',
    ).toBe(false);
  });

  it('applied inside the subshell, so planning values cannot leak into the writer', () => {
    expect(invocation()).toMatch(/plan_text=\$\(\s*\n\s*\[ -n/);
  });

  it('the loader reads all four planning knobs from config', () => {
    for (const key of ['.planning.autoPlannerTiers', '.planning.temperature',
                       '.planning.topP', '.planning.reasoningEffort']) {
      expect(SRC, `${key} is never read — that setting is dead config`).toContain(key);
    }
  });

  it('planning sampling differs from at least one model\'s execution sampling', () => {
    // If it matched every model there would be nothing to separate, and the split would be
    // decoration. GLM-5.2 executes hot; planning must not.
    const execTemps = Object.values(CFG.modelOverrides)
      .map((m) => (m as { temperature?: number }).temperature)
      .filter((t): t is number => typeof t === 'number');
    expect(execTemps.some((t) => t !== CFG.planning.temperature)).toBe(true);
  });

  it('the config declares the planning stage', () => {
    expect(typeof CFG.planning.temperature).toBe('number');
    expect(typeof CFG.planning.topP).toBe('number');
    expect(typeof CFG.planning.reasoningEffort).toBe('string');
    expect(Array.isArray(PLANNED)).toBe(true);
  });
});
