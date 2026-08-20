// A REPLAY GUARD MUST DISCOVER ITS SUBJECT, NOT NAME IT.
//
// Removing the absolute paths was only half the job. The guards still named a repository
// ('next.metrolinx.com'), a branch ('amsd-2041-approved-af1d6b99'), commit SHAs ('42b81c44') and
// packages ('next-auth', '@contentstack/live-preview-utils'). Every one is a fact about one
// client's estate on one day, written into the ENGINE's test suite — so the guards only prove
// anything for that estate, and they rot the moment a branch is pruned or a ticket closes.
//
// The property under test never mentioned any of them: "a dependency the change ADDS is
// introduced; one already in the baseline is not." That holds for any repository, any ecosystem,
// any pair of commits. So the guard finds a real repository through the roots the project configs
// declare, finds a real commit that really added a dependency, and asserts the property there.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverManifestRepo, discoverDependencyAddingChange } from '../../support/replay-codeline';

const ROOT = join(__dirname, '../../..');
const GUARDS = [
  'brownfield-cve-hard-stopped-on-existing-debt',
  'manifest-and-lockfile-drifted-apart',
  'helper-gate-judged-by-real-diffs',
];

describe('discovery, rather than naming', () => {
  it('finds a real repository carrying a manifest and a lockfile', () => {
    const repo = discoverManifestRepo();
    expect(repo, 'no declared root holds a repository with a manifest AND a lockfile').not.toBe('');
  });

  it('finds a real change that really added a dependency', () => {
    const repo = discoverManifestRepo();
    const change = discoverDependencyAddingChange(repo);
    expect(change, 'no commit in this repository adds a dependency — nothing to replay').not.toBeNull();
    expect(change!.added.length, 'the discovered change adds nothing').toBeGreaterThan(0);
    expect(change!.baseRef).toMatch(/^[0-9a-f]{7,40}$/);
    expect(change!.headRef).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('the discovered change is real — its added names are absent at the baseline', () => {
    const repo = discoverManifestRepo();
    const change = discoverDependencyAddingChange(repo)!;
    for (const name of change.added) {
      expect(change.baselineDeps, `${name} was already declared at the baseline`).not.toContain(name);
      expect(change.headDeps, `${name} is not declared at the head either`).toContain(name);
    }
  });
});

describe('the replay guards carry no estate facts', () => {
  const literals = (body: string) =>
    body.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      // a repository, branch or ticket name, or a bare commit sha, written as a string literal
      .filter(({ l }) => /'[^']*(next\.[a-z]|mock-[a-z]|azure\.|amsd-|AMSD-)[^']*'/.test(l)
                      || /['"][0-9a-f]{8,40}['"]/.test(l));

  for (const g of GUARDS) {
    it(`${g} names no repository, branch or commit`, () => {
      const body = readFileSync(join(ROOT, `test/unit/orchestration/${g}.test.ts`), 'utf8');
      const bad = literals(body).map(({ l, n }) => `${g}.test.ts:${n}: ${l.trim().slice(0, 80)}`);
      expect(bad, `estate facts hardcoded in an engine guard:\n${bad.join('\n')}`).toEqual([]);
    });
  }
});
