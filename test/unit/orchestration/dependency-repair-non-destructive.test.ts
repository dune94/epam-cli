/**
 * A repair must never leave the codeline worse than it found it.
 *
 * Live AMSD-2041 run 6. `next.gotransit.com` had a working install — 1,530
 * packages. After the run it had `node_modules` with ZERO entries, and Step 5
 * failed reporting "node_modules: empty".
 *
 * The pipeline did it. `detect_and_install_dependencies` selects `ci` whenever a
 * lockfile exists, and `npm ci` DELETES node_modules before installing. So:
 *
 *   1. the manifest referenced a package from a registry we cannot authenticate to
 *   2. the repair ran the destructive command first
 *   3. the fetch returned 401 and the install aborted
 *   4. node_modules was left empty — the codeline strictly worse than before
 *
 * The warning text already said "often a private-registry auth wall": the code
 * anticipated the failure and still destroyed first. It also explains why the
 * estate looked unprepared that morning — earlier runs had been emptying it.
 *
 * TWO DECISIONS, ONLY ONE OF WHICH IS OURS:
 *
 *   WHICH package manager — the PROJECT's answer. Its `packageManager` field if
 *   it declares one (the standard corepack field), else its lockfile. Read,
 *   never assumed.
 *
 *   DESTRUCTIVE OR NOT — our policy, and the default must be non-destructive.
 *   We did not create these repositories and cannot restore what we remove.
 *
 * And the outcome is verified rather than trusted: if a repair reduces what was
 * installed, that is reported loudly instead of being handed to the next gate as
 * a working tree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

/** The dependency-install region. */
function installBlock(): string {
  const i = src.indexOf('detect_and_install_dependencies()');
  expect(i, 'detect_and_install_dependencies not found').toBeGreaterThan(-1);
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j > i ? j : i + 6000);
}

describe('the repair does not destroy what it cannot restore', () => {
  it('does not run a destructive install by default', () => {
    // `ci` wipes node_modules before installing. On a codeline we did not
    // create, with a dependency we may not be able to fetch, that converts a
    // working tree into an empty one.
    //
    // Asserts the CONDITION, not the absence of the string: the destructive
    // variant may exist, but every line that selects it must be gated on the
    // explicit opt-in. A line choosing it from a lockfile alone is the defect.
    const code = installBlock().split('\n').filter((l) => !/^\s*#/.test(l));
    const ungated = code.filter((l) => /pm_cmd="ci"/.test(l) && !/CLEAN_INSTALL/.test(l));
    expect(ungated,
      `a destructive install is selected without an explicit opt-in:\n${ungated.join('\n')}`)
      .toEqual([]);
  });

  it('allows a destructive install only when explicitly configured', () => {
    // Policy, not prohibition: a caller that owns the tree may want a clean
    // install. It must be a deliberate choice, not the default.
    expect(installBlock(), 'there is no way to opt into a clean install at all')
      .toMatch(/DEPS_CLEAN_INSTALL|CLEAN_INSTALL/);
  });

  it('verifies the repair did not reduce what was installed', () => {
    // A repair that empties the tree must not be handed to the next gate as if
    // it worked. Count before, count after.
    expect(installBlock(), 'nothing checks whether the repair made things worse')
      .toMatch(/_before|_prior_count|entries_before/i);
  });

  it('says so loudly when a repair leaves less than it found', () => {
    const i = installBlock().search(/_before|_prior_count|entries_before/i);
    expect(i, 'no before/after comparison exists').toBeGreaterThan(-1);
    expect(installBlock().slice(i),
      'a repair that destroyed the tree passes silently')
      .toMatch(/warning |error /);
  });
});

describe('which package manager is the project\'s answer, not ours', () => {
  it('honours a declared packageManager field', () => {
    // The standard corepack field. If the project states it, that is the answer
    // and no lockfile guessing is needed.
    expect(installBlock(), 'a project that declares its package manager is ignored')
      .toMatch(/packageManager/);
  });

  it('still falls back to the lockfile the project committed', () => {
    expect(installBlock()).toMatch(/lock/i);
  });
});
