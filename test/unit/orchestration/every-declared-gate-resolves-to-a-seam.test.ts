/**
 * A GATE THE REGISTRY DECLARES MUST BE REACHABLE BY THE NAME IT IS CALLED BY.
 *
 * The QA gates are declared in invocation-profiles.json under a namespaced key —
 * `qa-gate:runtime-boundary` — while everything that CALLS one names it bare: the roster lists
 * `runtime-boundary`, and profiles.json holds its persona under that name too. resolveSeam matched
 * the key exactly, so the bare name missed, and the agent fell through to the suffix patterns.
 *
 * Five of the eight gates resolved anyway — purely because their names happen to end in a suffix
 * the registry declares for some other family (-validator, -ranger, -hunter, -weaver, -sentinel).
 * The three whose names do not — sast, e2e, runtime-boundary — resolved to nothing and would have
 * run "with no ladder, no effort and no tool grants". runtime-boundary has never once executed.
 *
 * Routing by suffix coincidence is what this test ends: the declaration is what routes.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

const { resolveSeam, registryPath } = require('../../../orchestrations/scripts/lib/seam-invocation.js');

function declaredProfileKeys(): string[] {
  const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
  return Object.keys(reg.profiles || {});
}

describe('every declared gate resolves to a seam', () => {
  const namespaced = declaredProfileKeys().filter((k) => k.includes(':'));

  it('the registry declares namespaced gates at all', () => {
    // Guard against a vacuous pass: if the registry stopped using namespaced keys, every
    // assertion below would iterate an empty list and prove nothing.
    expect(namespaced.length).toBeGreaterThan(0);
  });

  it.each(namespaced)('%s is reachable by its bare name', (key) => {
    const bare = key.split(':').pop() as string;
    let seam: string | null = null;
    expect(() => { seam = resolveSeam(bare); },
      `'${bare}' is declared as '${key}' but resolves to no seam, so it would run with no ladder, `
      + 'no effort and no tool grants').not.toThrow();
    expect(seam).toBeTruthy();
  });

  it('routes by the declaration, not by a lucky suffix', () => {
    // runtime-boundary is the case that proves it: its name ends in no declared family suffix.
    expect(resolveSeam('runtime-boundary')).toBe('qa-gate:runtime-boundary');
  });
});
