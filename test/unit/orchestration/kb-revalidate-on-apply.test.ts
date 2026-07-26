/**
 * Stored rules must be re-checked when APPLIED, not only when admitted.
 *
 * Admission is a one-time gate on a PERMANENT store. Anything already inside —
 * admitted before a guard existed, or while a guard was inert — is applied forever
 * without ever being re-examined.
 *
 * That is not hypothetical. The harmful EPAM_MAX_ITERATIONS=14 rule had to be
 * archived BY HAND twice on 2026-07-25: once after the run it sabotaged, and again
 * after the next run re-admitted it through a guard that was silently inert.
 *
 * TTL does not save us either, and is in fact backwards here. tick() resets
 * cycles_idle to 0 whenever a rule FIRES:
 *
 *     if (fired.includes(c.id)) return { ...c, cycles_idle: 0, ... }
 *
 * so ageing only removes rules that stop being used. The harmful rule fired on
 * every attempt of every run, so its counter reset each time and it could never
 * expire. The more damage it did, the more it fired, and the more permanent it
 * became — usage is being treated as a proxy for value.
 *
 * Re-validating at apply time closes the hole for every rule already in the store.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'reval-')); dirs.push(root);
  for (const m of ['kb-store.js', 'kb-arbitration.js']) {
    delete require.cache[require.resolve(join(LIB, m))];
  }
  const store = require(join(LIB, 'kb-store.js'));
  store.configure({ root });
  return { root, store };
}

/** A harmful rule written straight to the store, bypassing admission entirely —
 *  exactly the state left behind by a run that predates the guard. */
function plantHarmfulRule(store: any) {
  store.writeConstraints([{
    id: 'repro-test-writer-class-max-iterations',
    scope: { agent_role: 'repro-test-writer' },
    trigger: { signature: 'class:max_iterations' },
    enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value: '14' },
    reason: 'legacy rule admitted before the sanity guard existed',
    origin_episodes: ['e-1'],
    ttl_cycles: 20, cycles_idle: 0, status: 'active',
  }]);
  store.recordEpisode({
    id: 'e-1', signature: 'class:max_iterations', agent_role: 'repro-test-writer',
    story_id: 'S', diagnosis: 'ran out', observed_limit: 15,
  });
}

describe('a harmful stored rule cannot be applied', () => {
  it('lookup() refuses to return it', () => {
    const { store } = freshStore();
    plantHarmfulRule(store);
    const found = store.lookup({ agent_role: 'repro-test-writer', signature: 'class:max_iterations' });
    expect(found.length,
      'a rule that predates the guard is still handed to the compiler — admission ' +
      'is a one-time gate on a permanent store')
      .toBe(0);
  });

  it('still returns a sane rule', () => {
    const { store } = freshStore();
    plantHarmfulRule(store);
    const all = store.readConstraints();
    store.writeConstraints([{ ...all[0], enforcement: { ...all[0].enforcement, value: '40' } }]);
    const found = store.lookup({ agent_role: 'repro-test-writer', signature: 'class:max_iterations' });
    expect(found.length, 'a legitimate rule was refused').toBe(1);
  });
});

describe('TTL ageing is documented as usage-based, not outcome-based', () => {
  it('tick() resets the idle counter when a rule fires', () => {
    const src = readFileSync(join(LIB, 'kb-arbitration.js'), 'utf8');
    // Pinning current behaviour deliberately: a rule that fires constantly can
    // never age out, so ageing must not be relied on to remove a harmful rule.
    expect(src).toMatch(/fired\.includes\(c\.id\)[\s\S]{0,80}cycles_idle: 0/);
  });
});
