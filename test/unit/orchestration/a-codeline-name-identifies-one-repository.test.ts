/**
 * A CODELINE NAME IS A PRIMARY KEY, SO IT MUST IDENTIFY ONE REPOSITORY.
 *
 * codeline-name.js says so in its own header — the name keys byCodeline, the KB stores,
 * story.codelines, project.outputDirs, the lane loop, and the per-codeline fix-site and
 * verification-criteria maps — and warns that dropping words "is how a distinct repo can collide
 * with another or point at a worktree that does not exist".
 *
 * Then it drops words. A hardcoded DECORATION list strips platform and framework prefixes, so in a
 * real estate three sibling checkouts of one product collapse onto a single identifier:
 *
 *     azure.<product>.com  ->  <product>
 *     next.<product>.com   ->  <product>
 *     react.<product>.com  ->  <product>
 *
 * A story naming that product resolves to whichever of the three the lane loop reached first — an
 * infrastructure repository for a front-end change, or the reverse. It is silent, because a lane
 * keyed on a colliding name looks exactly like a lane keyed on a correct one.
 *
 * The stripping is a PREFERENCE, not a fact: shorter when nothing is lost, full when shortening
 * would erase the difference between two repositories. So the uniqueness has to be decided across
 * the whole set, which is what deriveCodelineNames already sees.
 *
 * No client repository names appear here. The shape is what reproduces the defect.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const { deriveCodelineName, deriveCodelineNames, DECORATION } =
  require(join(__dirname, '../../../orchestrations/scripts/lib/codeline-name.js'));

/** A set of codelines as discovery hands them over. */
const codelines = (...dirs: string[]) =>
  ({ codelines: dirs.map((d) => ({ name: 'whatever-the-model-said', path: `/estate/${d}` })) });

const namesOf = (parsed: any) => parsed.codelines.map((c: any) => c.name);

describe('a codeline name identifies one repository', () => {
  it('the decoration list is what makes siblings collide — the premise, stated as a fact', () => {
    // Guards the vacuous pass: if DECORATION were emptied, every assertion below would hold for
    // the wrong reason and the fix would look unnecessary.
    expect(DECORATION.size, 'the decoration list is empty; this test proves nothing')
      .toBeGreaterThan(3);
    const bare = ['azure', 'next', 'react'].map((p) => deriveCodelineName(`${p}.product.com`));
    expect(new Set(bare).size,
      'stripping no longer collapses siblings, so the defect shape has changed').toBe(1);
  });

  it('siblings of one product keep distinct names', () => {
    const out = namesOf(deriveCodelineNames(
      codelines('azure.product.com', 'next.product.com', 'react.product.com')));
    expect(new Set(out).size,
      `three repositories share ${out.length - new Set(out).size + 1} name(s): ${out.join(', ')}`)
      .toBe(3);
  });

  it('and no repository silently answers to another one\'s key', () => {
    const out = namesOf(deriveCodelineNames(
      codelines('azure.product.com', 'next.product.com', 'react.product.com')));
    for (const n of out) expect(n, 'a name lost the word that distinguishes it').toMatch(/product/);
    expect(out).toEqual(expect.arrayContaining([
      expect.stringContaining('azure'),
      expect.stringContaining('next'),
      expect.stringContaining('react'),
    ]));
  });

  it('no collision means no change — a lone repository keeps the short name', () => {
    // The negative half. Disambiguating unconditionally would rename every codeline in every
    // existing estate, and every registry keyed on the old name with it.
    expect(namesOf(deriveCodelineNames(codelines('next.product.com')))).toEqual(['product']);
    expect(namesOf(deriveCodelineNames(codelines('next.alpha.com', 'react.beta.com'))))
      .toEqual(['alpha', 'beta']);
  });

  it('the result does not depend on the order they were discovered in', () => {
    // A key that depends on iteration order is a key that changes between a mint and a resume,
    // which is how registries written one way were read the other.
    const a = namesOf(deriveCodelineNames(
      codelines('azure.product.com', 'next.product.com', 'react.product.com')));
    const b = namesOf(deriveCodelineNames(
      codelines('react.product.com', 'azure.product.com', 'next.product.com')));
    expect([...a].sort()).toEqual([...b].sort());
    expect(b[0], 'the same directory got a different name in a different order').toBe(a[2]);
  });

  it('what the model called it is still preserved', () => {
    const out = deriveCodelineNames(codelines('azure.product.com', 'next.product.com'));
    for (const c of out.codelines) {
      expect(c.modelName, 'a rename became implicit').toBe('whatever-the-model-said');
    }
  });

  it('a name is still never empty', () => {
    for (const d of ['azure', 'www', 'app.com', '.', '---']) {
      expect(deriveCodelineName(d), `${d} derived an empty key`).not.toBe('');
    }
  });
});
