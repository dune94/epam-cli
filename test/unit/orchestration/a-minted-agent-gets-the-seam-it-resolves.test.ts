/**
 * A MINTED AGENT MUST GET THE SEAM IT RESOLVES TO — RESOLVING IS NOT APPLYING.
 *
 * resolveSeam() matches three ways: an exact `profiles` key, an `agentSeams` entry, or a
 * seamPattern. The patterns exist PRECISELY for minted names — `-investigator`, `-engineer`,
 * `-fixer` — which are the agents that do the actual work of a run.
 *
 * seam_ladder_export, the function that actually APPLIES a seam, accepted only the first two. So a
 * minted agent resolved a seam on paper and got nothing at runtime: no ladder, no reasoning
 * effort, no output-token budget. Measured on a real mock3 run: mocka-investigator,
 * mockb-investigator and transit-logic-engineer all resolved a seam and all ran unconfigured.
 *
 * That gap is also why the registry carried 61 hand-written agentSeams entries against 20
 * patterns. Patterns did not work at the apply seam, so every agent had to be enumerated to
 * function at all — the enumeration was a SYMPTOM of this defect, not a design choice.
 *
 * The guard that must survive: a name matching NO pattern still gets nothing, rather than a guess.
 * That is the 2026-08-15 defect, where seven agents were silently given the wrong configuration.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const LADDER = join(SCRIPTS, 'lib/seam-ladder.sh');
const REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const NODE = process.execPath;

/**
 * Apply a seam exactly as run_orch_prompt does, and report what the agent would run with.
 *
 * REASONING EFFORT IS NO LONGER PART OF THIS ANSWER, and that is a change of ownership rather
 * than a loss. Until 2026-09-01 a seam declared a flat reasoningEffort, seam-invocation exported
 * it, and next_ladder_step treated the rung's own configured level as a FLOOR — so the seam's
 * value won whenever it was higher, which for 33 of 41 seams meant "high" on every rung. The
 * ladder's cheap entry rung could never be cheap. Operator rule, same date: a seam is ASSIGNED to
 * a ladder and does not renegotiate what that ladder costs, exactly as already settled for
 * maxIterations.
 *
 * So effort is now the RUNG's, applied by claude.sh at call time from EPAM_RUNG<N>_REASONING_EFFORT.
 * It is legitimately absent here, at seam-export time, and asserting on it would pin the defect.
 *
 * The defect this file exists for is untouched and still asserted: a minted agent that resolves a
 * seam on paper and gets NOTHING at runtime. That is now proven by the model, the ladder chain and
 * the token budget it receives — the things this layer genuinely owns.
 */
function applied(agent: string): { rc: number; model: string; ladder: string; tokens: string } {
  const r = spawnSync('bash', ['-c',
    `set -a; . ${JSON.stringify(join(SCRIPTS, 'lib/model-ladders.sh'))}; set +a
     export_model_ladders ${JSON.stringify(join(ROOT, 'orchestrations/projects/mock3/llm-settings.json'))} >/dev/null 2>&1
     . ${JSON.stringify(LADDER)}
     seam_ladder_export ${JSON.stringify(agent)} >/dev/null 2>&1; rc=$?
     echo "rc=$rc model=\${EPAM_MODEL:-NONE} ladder=\${EPAM_MODEL_LADDER:-NONE} tokens=\${EPAM_MAX_OUTPUT_TOKENS:-NONE}"`,
  ], { encoding: 'utf8', env: { ...process.env, NODE_BIN: NODE } });
  const m = /rc=(\d+) model=(\S+) ladder=(\S+) tokens=(\S+)/.exec(r.stdout.trim().split('\n').pop() || '');
  expect(m, `no result for ${agent}: ${r.stdout}${r.stderr}`).toBeTruthy();
  return { rc: Number(m![1]), model: m![2], ladder: m![3], tokens: m![4] };
}

describe('a minted agent gets the seam it resolves', () => {
  it('a pattern-matched name is CONFIGURED, not merely resolved', () => {
    // The three names a real mock3 run minted. Each matches a seamPattern and nothing else.
    for (const agent of ['mocka-investigator', 'transit-logic-engineer', 'some-new-fixer']) {
      const got = applied(agent);
      expect(got.rc, `${agent} resolves a seam but the registry refused to apply it`).toBe(0);
      expect(got.model, `${agent} would run with no model`).not.toBe('NONE');
      expect(got.ladder, `${agent} would run with no ladder to climb`).not.toBe('NONE');
      expect(got.tokens, `${agent} would run with no output-token budget`).not.toBe('NONE');
    }
  });

  it('a name matching NO pattern still gets nothing — no guess', () => {
    // The 2026-08-15 defect: wrong configuration presented as resolved configuration is worse
    // than none. Note the name must not end in "-agent", which is itself a legitimate pattern
    // ("generic minted worker") — an earlier fixture used one and read its own success as failure.
    const got = applied('zzz-matches-no-pattern');
    expect(got.rc, 'an unknown agent was silently given a seam').toBe(3);
    // Asserted on what this layer still supplies. The old check read EPAM_REASONING_EFFORT, which
    // is now absent for EVERY agent — so it would pass here without proving anything.
    expect(got.model, 'an unresolved agent was handed a model anyway').toBe('NONE');
    expect(got.tokens, 'an unresolved agent was handed a token budget anyway').toBe('NONE');
  });

  it('apply and resolve agree — one resolution, not two', () => {
    // The defect in one line: two different notions of "does this agent have a seam".
    const body = readFileSync(LADDER, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(body, 'apply still does its own narrower lookup instead of asking resolveSeam')
      .toMatch(/resolveSeam\(process\.argv\[2\]\)/);
    expect(body, 'the exact-key-only check is back')
      .not.toMatch(/reg\.profiles \|\| \{\}\)\[process\.argv\[2\]\] \|\| \(reg\.agentSeams/);
  });

  it('every agent an exact entry covers is unaffected', () => {
    // The change must widen what works, never alter what already did. 57 of 60 profiles on the
    // real roster resolve by exact key; a regression there would silently re-tier the whole run.
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const exact = Object.keys(reg.agentSeams || {}).filter((a) => !/(^|-)(investigator|engineer|fixer|agent)$/.test(a));
    expect(exact.length, 'no exactly-declared agent found to check').toBeGreaterThan(5);
    for (const agent of exact.slice(0, 6)) {
      const got = applied(agent);
      expect(got.rc, `${agent} stopped resolving`).toBe(0);
      expect(got.model, `${agent} lost its model`).not.toBe('NONE');
      expect(got.tokens, `${agent} lost its output-token budget`).not.toBe('NONE');
    }
  });

  it('a new agent type is onboarded by naming it, not by editing the registry', () => {
    // The point of the whole mechanism: extensibility without enumeration.
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const novel = 'payments-ledger-investigator';
    expect(Object.keys(reg.agentSeams || {}), 'the fixture is pre-declared, so it proves nothing')
      .not.toContain(novel);
    expect(Object.keys(reg.profiles || {}), 'the fixture is a profile, so it proves nothing')
      .not.toContain(novel);

    const got = applied(novel);
    expect(got.rc, 'a never-before-seen minted name gets no configuration').toBe(0);
    expect(got.model, 'a never-before-seen minted name got no model').not.toBe('NONE');
    expect(got.ladder, 'a never-before-seen minted name got no ladder').not.toBe('NONE');
  });
});
