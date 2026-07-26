/**
 * The sanity guard is now a LEGACY DEFENCE, and that is all it is.
 *
 * Budget parameters are unconstructable as of kb_schema.py's ParamEnforcement
 * validator, so a budget rule can no longer be ADMITTED: validate() rejects it
 * before arbitration or sanity ever runs. The admission-path tests that used to
 * live here tested a path that no longer exists, and were deleted rather than
 * re-fixtured.
 *
 * What remains real: the store PERSISTS across runs by design, so it can still
 * contain a budget rule written before that change — this session produced two
 * (EPAM_MAX_ITERATIONS=14, then =1). lookup() re-validates on the way out, so such
 * a rule can never be applied even though it is sitting in constraints.json.
 *
 * Why this matters: admission is a one-time gate on a permanent store. Without the
 * exit check, anything admitted before a rule existed is enforced forever. Both
 * live harmful rules had to be archived BY HAND before this was added.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-')); dirs.push(root);
  delete require.cache[require.resolve(join(LIB, 'kb-store.js'))];
  const store = require(join(LIB, 'kb-store.js'));
  store.configure({ root });
  return { root, store };
}

/** Written straight to disk, bypassing validate() — exactly the state a run from
 *  before the schema change leaves behind. */
function plantLegacy(store: any, value: string) {
  store.writeConstraints([{
    id: 'repro-test-writer-class-max-iterations',
    scope: { agent_role: 'repro-test-writer' },
    trigger: { signature: 'class:max_iterations' },
    enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value },
    reason: 'admitted before budget params became unconstructable',
    origin_episodes: ['e-1'],
    ttl_cycles: 20, cycles_idle: 0, status: 'active',
  }]);
  store.recordEpisode({
    id: 'e-1', signature: 'class:max_iterations', agent_role: 'repro-test-writer',
    story_id: 'S', diagnosis: 'ran out', observed_limit: 15,
  });
}

describe('a legacy budget rule cannot be applied', () => {
  it('lookup() refuses the live "ran out at 15, so use 14" rule', () => {
    const { store } = freshStore();
    plantLegacy(store, '14');
    expect(store.lookup({ agent_role: 'repro-test-writer', signature: 'class:max_iterations' }).length,
      'a stored budget rule from before the schema change is still applied — ' +
      'admission is a one-time gate on a permanent store')
      .toBe(0);
  });

  it('lookup() refuses the "one turn" rule too', () => {
    const { store } = freshStore();
    plantLegacy(store, '1');
    expect(store.lookup({ agent_role: 'repro-test-writer', signature: 'class:max_iterations' }).length)
      .toBe(0);
  });

  it('a non-budget stored rule is still returned', () => {
    const { store } = freshStore();
    store.writeConstraints([{
      id: 'r', scope: { agent_role: 'repro-test-writer' },
      trigger: { signature: 'class:max_iterations' },
      enforcement: { kind: 'param', name: 'EPAM_TEMPERATURE', value: '0' },
      reason: 'deterministic output', origin_episodes: [],
      ttl_cycles: 20, cycles_idle: 0, status: 'active',
    }]);
    expect(store.lookup({ agent_role: 'repro-test-writer', signature: 'class:max_iterations' }).length,
      'a legitimate stored rule was refused').toBe(1);
  });
});
