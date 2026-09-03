/**
 * A SEAM THAT ASKS FOR THE HIGHEST LADDER MUST GET THE HIGHEST LADDER.
 *
 * WRITTEN BEFORE THE FIX.
 *
 * llm-settings.json declares three ladders, and claude.sh serialises all three into
 * EPAM_MODEL_LADDER_<TIER> — but each export is guarded "only if unset":
 *
 *     _v=$(_get '[.ladders.highest.modelLadder[]? | "\(.from)=\(.to)"] | join("|")')
 *     [ -z "${EPAM_MODEL_LADDER_HIGHEST:-}" ] && [ -n "$_v" ] && export EPAM_MODEL_LADDER_HIGHEST="$_v"
 *
 * config.env sets it FIRST, unconditionally, to a single hand-written pair:
 *
 *     EPAM_MODEL_LADDER_HIGHEST="z-ai/glm-5.2=moonshotai/kimi-k3"
 *
 * So the declared seven-transition ladder never applies, and every seam on HIGHEST —
 * team-lead-review, code-graph-detective, roster-review, estate-survey, guard-vocabulary and
 * (since 2026-08-12) both failure analysts — climbs a ladder with ONE step. Live that same day:
 *
 *     [FailureAnalyst] analyst ladder exhausted at 'z-ai/glm-5.2' (tier=HIGHEST)
 *
 * Moving the analysts from "high" to "HIGHEST" therefore made their ladder SHORTER, which is
 * the opposite of the intent. The ladder they left has seven transitions.
 *
 * This is the same shape as SKIP_REGRESSION_GUARD=false in the same file: a project default
 * assigned unconditionally, overriding the thing that should own the value. The rule there
 * applies here — llm-settings.json is the declaration; config.env must not silently outrank it.
 *
 * ONE SOURCE. The ladder a tier contains is declared in llm-settings.json and nowhere else.
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
const REPO_ROOT_CFG = join(__dirname, '../../../orchestrations/config');

const ROOT = join(__dirname, '../../../');
const SETTINGS = join(REPO_ROOT_CFG, `llm-defaults.${defaultStack()}.json`);
const CONFIG_ENV = join(ROOT, 'orchestrations/projects/metrolinx/config.env');

/** The chain llm-settings DECLARES for a tier. */
function declared(tier: string): string[] {
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  return ((s.ladders?.[tier]?.modelLadder) || []).map((p: any) => `${p.from}=${p.to}`);
}

/** The chain a run actually gets, loading config.env then the llm-settings exporter. */
function inForce(tier: string): string[] {
  const varName = `EPAM_MODEL_LADDER_${tier.toUpperCase()}`;
  const out = execFileSync('bash', ['-c', `set +e
    . ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/env-file.sh'))} 2>/dev/null || true
    if command -v load_env_file >/dev/null 2>&1; then
      load_env_file ${JSON.stringify(CONFIG_ENV)} >/dev/null 2>&1
    else
      . ${JSON.stringify(CONFIG_ENV)} >/dev/null 2>&1
    fi
    # the exporter, lifted from claude.sh, in the same order a run applies it
    _get() { jq -r "$1" ${JSON.stringify(SETTINGS)} 2>/dev/null; }
    _v=$(_get '[.ladders.highest.modelLadder[]? | "\\(.from)=\\(.to)"] | join("|")')
    [ -z "\${EPAM_MODEL_LADDER_HIGHEST:-}" ] && [ -n "$_v" ] && export EPAM_MODEL_LADDER_HIGHEST="$_v"
    _v=$(_get '[.ladders.high.modelLadder[]? | "\\(.from)=\\(.to)"] | join("|")')
    [ -z "\${EPAM_MODEL_LADDER_HIGH:-}" ] && [ -n "$_v" ] && export EPAM_MODEL_LADDER_HIGH="$_v"
    printf '%s' "\${${varName}:-}"`], { encoding: 'utf8' });
  return out ? out.split('|').filter(Boolean) : [];
}

describe('the declaration is real', () => {
  it('llm-settings declares a multi-step highest ladder', () => {
    // If this is ever a single step, the test below proves nothing.
    expect(declared('highest').length,
      'llm-settings declares no meaningful highest ladder — this test is vacuous')
      .toBeGreaterThan(1);
  });
});

describe('THE DEFECT: THE DECLARED LADDER IS NOT THE ONE IN FORCE', () => {
  it('HIGHEST in force matches HIGHEST as declared', () => {
    expect(inForce('highest'),
      'a seam asking for HIGHEST climbs a ladder llm-settings never declared — config.env is ' +
      'overriding the declaration')
      .toEqual(declared('highest'));
  });

  it('HIGHEST is not SHORTER than HIGH — that is the wrong way round', () => {
    // The concrete consequence: moving a seam up a tier made its ladder shorter.
    expect(inForce('highest').length,
      'the "highest" tier offers fewer escalations than "high"')
      .toBeGreaterThanOrEqual(declared('high').length);
  });
});

describe('ONE SOURCE FOR WHAT A TIER CONTAINS', () => {
  it('config.env does not hand-write a model ladder', () => {
    // Not a style preference: config.env is loaded first and its assignment is unconditional,
    // so anything it writes here silently wins over the declaration — the same defect as
    // SKIP_REGRESSION_GUARD=false a few lines below it in the same file.
    const cfg = readFileSync(CONFIG_ENV, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => /^\s*EPAM_MODEL_LADDER[A-Z_]*=\S/.test(l));
    expect(cfg, `config.env pins a ladder that llm-settings.json owns:\n${cfg.join('\n')}`)
      .toEqual([]);
  });
});
