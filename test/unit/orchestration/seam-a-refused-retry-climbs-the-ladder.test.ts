/**
 * A RETRY THAT DOES NOT CLIMB IS THE SAME COIN FLIPPED AGAIN.
 *
 * Live 2026-08-27, run 20260827T092415Z: prompt-builder refused to produce a valid 'tc-writer'
 * three times and aborted the run at the mint step. Attempts 1 and 2 dropped the IDENTICAL two
 * placeholders — because it was the identical model doing the identical thing. seamInvocationEnv
 * took no rung, `runText(prompt, meta)` received `meta.attempt` and used it only for the log
 * FILENAME, and the chain haiku -> sonnet -> opus sat published and unwalked while the run died.
 *
 * The ladder is what a repeated failure is FOR. Feeding the refusal back (which this pipeline
 * already did) without climbing asks the same model to notice what it just missed.
 *
 * THE CHAIN IS A HOP MAP, AND THIS TEST EXISTS BECAUSE THE FIRST FIX ASSUMED OTHERWISE.
 * model-ladders.sh emits `from=to|from=to`, not a comma-separated list. The first implementation
 * split on ',' , verified green against a fixture the author had written in the assumed format,
 * and did not climb at all against the real one. So every expectation here is driven by
 * export_model_ladders' OWN output — the real producer's value, never a hand-authored chain.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PROJECT_DIR = join(REPO_ROOT, 'orchestrations/projects/mock3');

/** The ladder environment exactly as a run builds it: sourced, then exported, in one shell. */
function realLadderEnv(): Record<string, string> {
  const out = execFileSync('bash', ['-c', `
    . orchestrations/scripts/lib/model-ladders.sh
    export_model_ladders "${PROJECT_DIR}/llm-settings.json" >/dev/null 2>&1
    printenv
  `], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, EPAM_PROVIDER_SET: 'claude', NODE_BIN: process.execPath,
           EPAM_PROJECT_CONFIG_DIR: PROJECT_DIR },
  });
  // Filtered HERE, not in the shell: this machine's `grep` is ugrep, which swallowed the output
  // of `env | grep` entirely and made a working export look like an empty one — twice.
  return Object.fromEntries(out.trim().split('\n').filter((l) => l.startsWith('EPAM_MODEL_LADDER')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
  }));
}

let ladderEnv: Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seamInvocationEnv } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/seam-invocation.js'));

const modelAt = (seam: string, rung: number): string =>
  seamInvocationEnv(seam, undefined, { env: { ...ladderEnv, EPAM_PROJECT_CONFIG_DIR: PROJECT_DIR }, rung })
    .EPAM_MODEL || '';

beforeAll(() => { ladderEnv = realLadderEnv(); });

describe('a refused attempt climbs the ladder it was assigned', () => {
  it('the harness holds the REAL exported chain, in the real hop-map format', () => {
    // Guards against a vacuous pass: if export_model_ladders exported nothing, every model below
    // would be '' and the not-equal assertions would all "pass" while proving nothing.
    expect(Object.keys(ladderEnv).length, 'export_model_ladders exported no chains').toBeGreaterThan(0);
    expect(ladderEnv.EPAM_MODEL_LADDER_HIGH, 'the chain is not a from=to hop map any more')
      .toMatch(/=/);
  });

  it('REPRODUCES the abort: prompt-builder no longer runs three attempts on one model', () => {
    const three = [0, 1, 2].map((r) => modelAt('prompt-builder', r));
    expect(three[0], 'rung 0 resolved nothing — the seam has no start model').toBeTruthy();
    expect(new Set(three).size, `all three attempts ran ${three[0]} — the retry never climbed`)
      .toBeGreaterThan(1);
  });

  it('climbs from the rung the seam DECLARES, not from a shared root', () => {
    // prompt-builder is `mid`, codeline-discovery is `top`. They must not start together.
    expect(modelAt('prompt-builder', 0)).not.toBe(modelAt('codeline-discovery', 0));
  });

  it('each rung is one hop along that seam\'s own chain', () => {
    const hops = new Map(
      ladderEnv.EPAM_MODEL_LADDER_HIGH.split('|')
        .map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }),
    );
    const r0 = modelAt('prompt-builder', 0);
    expect(modelAt('prompt-builder', 1)).toBe(hops.get(r0));
    expect(modelAt('prompt-builder', 2)).toBe(hops.get(hops.get(r0) as string));
  });

  it('a ladder that runs out stays on its top rung rather than failing', () => {
    const top = modelAt('prompt-builder', 2);
    expect(modelAt('prompt-builder', 3)).toBe(top);
    expect(modelAt('prompt-builder', 99)).toBe(top);
  });

  it('rung 0 is unchanged — an un-escalated call behaves exactly as before', () => {
    const withRung = modelAt('prompt-builder', 0);
    const without = seamInvocationEnv('prompt-builder', undefined,
      { env: { ...ladderEnv, EPAM_PROJECT_CONFIG_DIR: PROJECT_DIR } }).EPAM_MODEL;
    expect(withRung).toBe(without);
  });

  it('stamps the rung so an escalation is visible in the cost ledger', () => {
    // Without this the ledger showed `attempt: null` on every row and "did the retry escalate?"
    // could not be answered from the run's own record.
    const e = seamInvocationEnv('prompt-builder', undefined,
      { env: { ...ladderEnv, EPAM_PROJECT_CONFIG_DIR: PROJECT_DIR }, rung: 2 });
    expect(e.EPAM_LADDER_RUNG).toBe('2');
  });
});
