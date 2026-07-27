/**
 * Producers run before consumers, decided from the code rather than configured.
 *
 * A story spanning several codelines is executed lane by lane, sequentially. The
 * order was whatever discovery happened to return, which makes contract
 * injection useless: a completed codeline publishes its exported surface to
 * .contracts/, and the detective in a later lane reads it — but only if the lane
 * that produces the surface ran first. Wrong order and every lane investigates
 * blind, which is the failure MC-2 exists to prevent.
 *
 * The signal is already in the repositories. A shared library declares a package
 * name; the sites that use it list that name in their dependencies. That edge is
 * a fact about the code, not a preference to be configured — so ordering is a
 * topological sort over dependencies actually declared, with no map, no manifest
 * and no client vocabulary in the engine.
 *
 * Degrades to a no-op: repos with no edges between them keep the order they came
 * in, because inventing an order for independent work would be a guess dressed
 * as a decision.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { orderCodelines } from '../../../orchestrations/scripts/lib/codeline-score.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Build repos with real package.json files — the ordering reads them. */
function repos(spec: Record<string, { name: string; deps?: string[] }>) {
  const root = mkdtempSync(join(tmpdir(), 'cl-order-'));
  dirs.push(root);
  return Object.entries(spec).map(([dir, cfg]) => {
    const p = join(root, dir);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({
      name: cfg.name,
      dependencies: Object.fromEntries((cfg.deps || []).map(d => [d, '^1.0.0'])),
    }));
    return { name: dir, path: p };
  });
}

describe('a shared library runs before the sites that consume it', () => {
  it('puts the producer first even when it arrives last', () => {
    const list = repos({
      siteA:  { name: '@org/site-a', deps: ['@org/shared'] },
      siteB:  { name: '@org/site-b', deps: ['@org/shared'] },
      shared: { name: '@org/shared' },
    });
    const ordered = orderCodelines(list).map((r: any) => r.name);
    expect(ordered[0],
      'the shared library runs after its consumers, so their detectives read a ' +
      'contract that does not exist yet')
      .toBe('shared');
  });

  it('keeps consumers in their original relative order', () => {
    // Only the dependency edge is a fact. Ordering siteA before siteB would be
    // an invention.
    const list = repos({
      siteB:  { name: '@org/site-b', deps: ['@org/shared'] },
      shared: { name: '@org/shared' },
      siteA:  { name: '@org/site-a', deps: ['@org/shared'] },
    });
    const ordered = orderCodelines(list).map((r: any) => r.name);
    expect(ordered).toEqual(['shared', 'siteB', 'siteA']);
  });

  it('handles a chain', () => {
    const list = repos({
      app:  { name: '@org/app',  deps: ['@org/mid'] },
      mid:  { name: '@org/mid',  deps: ['@org/base'] },
      base: { name: '@org/base' },
    });
    expect(orderCodelines(list).map((r: any) => r.name)).toEqual(['base', 'mid', 'app']);
  });
});

describe('it refuses to invent an order it cannot justify', () => {
  it('leaves independent repos exactly as they came', () => {
    const list = repos({
      one: { name: '@org/one' },
      two: { name: '@org/two' },
    });
    expect(orderCodelines(list).map((r: any) => r.name)).toEqual(['one', 'two']);
  });

  it('survives a dependency cycle without dropping or duplicating a repo', () => {
    // A cycle has no valid topological order. Losing a codeline here would
    // silently skip a repository's work.
    const list = repos({
      a: { name: '@org/a', deps: ['@org/b'] },
      b: { name: '@org/b', deps: ['@org/a'] },
    });
    const ordered = orderCodelines(list).map((r: any) => r.name);
    expect([...ordered].sort()).toEqual(['a', 'b']);
  });

  it('survives a repo with no package.json', () => {
    const list = repos({ solo: { name: '@org/solo' } });
    list.push({ name: 'nonjs', path: '/tmp/definitely-not-here-xyz' });
    const ordered = orderCodelines(list).map((r: any) => r.name);
    expect(ordered.length, 'a repo was dropped because it declared no package').toBe(2);
  });

  it('ignores dependencies on packages outside the selected set', () => {
    // Every repo depends on third-party packages; only edges BETWEEN selected
    // codelines say anything about run order.
    const list = repos({
      one: { name: '@org/one', deps: ['react', 'lodash'] },
      two: { name: '@org/two', deps: ['react'] },
    });
    expect(orderCodelines(list).map((r: any) => r.name)).toEqual(['one', 'two']);
  });
});
