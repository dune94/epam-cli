/**
 * THE LADDERS ARE DECLARED ONCE AND EXPORTED THE SAME WAY BY EVERY ENTRY POINT.
 *
 * WRITTEN BEFORE THE FIX.
 *
 * llm-settings.json declares ladders.high / .medium / .highest, and the code that serialises
 * them into EPAM_MODEL_LADDER_<TIER> lives INSIDE claude.sh. Nothing else has it.
 *
 * So the tier a seam climbs depends on which entry point started the process:
 *
 *   via claude.sh          the declared chain (7 transitions for highest)
 *   via detective-rerun.sh NOTHING — it sources only env-file.sh and node-bin.sh
 *
 * Live 2026-08-13, in that exact order:
 *
 *   1. config.env pinned EPAM_MODEL_LADDER_HIGHEST to ONE pair, which beat the declaration
 *      because claude.sh only exports "if unset" — so every seam on HIGHEST had one step.
 *   2. Removing that pin fixed claude.sh-driven runs and BROKE the standalone one:
 *        [seam-invocation] agent 'code-graph-detective' ... asks for ladder 'HIGHEST',
 *        but EPAM_MODEL_LADDER_HIGHEST is unset
 *      The detective then investigated on whatever default happened to apply.
 *
 * Both are the same defect: WHERE the ladder comes from is duplicated. A project declares it
 * once; every process that invokes an agent must read that declaration the same way.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// LADDERS AND MODEL OVERRIDES MOVED TO THE STACK. The 2026-08-25 migration took them out of each
// project's llm-settings.json and into config/llm-defaults.<set>.json — a ladder names MODELS and
// a model belongs to a STACK. This file read the project copy, which now carries only a note
// saying so, so every lookup came back empty. See test/support/llm-settings.ts.
import { stackSettings, defaultStack } from '../../support/llm-settings'
const REPO_ROOT_CFG = join(__dirname, '../../../orchestrations/config');

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/model-ladders.sh');
const SETTINGS = join(REPO_ROOT_CFG, `llm-defaults.${defaultStack()}.json`);

function declared(tier: string): string {
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  return ((s.ladders?.[tier]?.modelLadder) || []).map((p: any) => `${p.from}=${p.to}`).join('|');
}

/** Load the shared lib, apply it, and report what a process would actually have. */
function exported(tier: string, preset: Record<string, string> = {}): string {
  const v = `EPAM_MODEL_LADDER_${tier.toUpperCase()}`;
  return execFileSync('bash', ['-c', `set +e
    ${Object.entries(preset).map(([k, x]) => `export ${k}=${JSON.stringify(x)}`).join('\n')}
    . ${JSON.stringify(LIB)} 2>/dev/null || exit 3
    export_model_ladders ${JSON.stringify(SETTINGS)} >/dev/null 2>&1
    printf '%s' "\${${v}:-}"`], { encoding: 'utf8' });
}

describe('THE EXPORT IS A SHARED LIB, NOT A COPY INSIDE ONE SCRIPT', () => {
  it('lib/model-ladders.sh exists', () => {
    expect(() => readFileSync(LIB, 'utf8'),
      'the ladder export lives inside claude.sh, so any other entry point has no ladders')
      .not.toThrow();
  });

  it('it exports every tier the project declares', () => {
    for (const tier of ['high', 'medium', 'highest']) {
      expect(exported(tier), `${tier} was not exported`).toBe(declared(tier));
    }
  });

  it('HIGHEST is the full declared chain, not a single pair', () => {
    expect(declared('highest').split('|').length,
      'the fixture no longer has a multi-step highest — this test is vacuous')
      .toBeGreaterThan(1);
    expect(exported('highest').split('|').length).toBe(declared('highest').split('|').length);
  });

  it('an already-set ladder still wins — an operator override is not clobbered', () => {
    expect(exported('highest', { EPAM_MODEL_LADDER_HIGHEST: 'a=b' })).toBe('a=b');
  });
});

describe('EVERY ENTRY POINT THAT INVOKES AN AGENT LOADS IT', () => {
  // The point of the lib. Naming the scripts individually is how they drifted apart, so this
  // enumerates every top-level script that invokes agents and requires each to source it.
  const entryPoints = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => {
      const s = readFileSync(join(SCRIPTS, f), 'utf8');
      const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      // "invokes an agent" = resolves a seam or invokes the runner directly
      return /seam_ladder_export|invoke_agent|runCodeGraphDetective|ai-run\.sh/.test(code);
    });

  it('there are entry points to check', () => {
    expect(entryPoints.length, 'no agent-invoking scripts found — the filter is stale')
      .toBeGreaterThan(1);
  });

  for (const f of readdirSync(SCRIPTS).filter((x) => x === 'detective-rerun.sh' || x === 'claude.sh')) {
    it(`${f} sources the shared ladder lib`, () => {
      const s = readFileSync(join(SCRIPTS, f), 'utf8');
      const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      expect(code, `${f} does not load lib/model-ladders.sh, so its seams get whatever happens to be in the environment`)
        .toMatch(/model-ladders\.sh/);
      // SOURCING IS NOT CALLING. The first version of this test asserted only the source line,
      // and passed while detective-rerun.sh defined the function and never invoked it — the
      // seam still reported "EPAM_MODEL_LADDER_HIGHEST is unset". A grep for a filename cannot
      // see whether anything runs.
      expect(code, `${f} sources the ladder lib but never calls export_model_ladders`)
        .toMatch(/export_model_ladders\s+\S/);
    });
  }
});

describe('THE OLD COPY IS GONE', () => {
  it('claude.sh no longer serialises the ladders itself', () => {
    // Two copies is one defect waiting: the inline block is what config.env was able to
    // outrank, and what no other entry point could reuse.
    const s = readFileSync(join(SCRIPTS, 'claude.sh'), 'utf8');
    const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code, 'claude.sh still has its own ladder serialisation')
      .not.toMatch(/ladders\.highest\.modelLadder/);
  });
});
