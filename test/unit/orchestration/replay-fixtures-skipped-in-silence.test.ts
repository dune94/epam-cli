// A REPLAY GUARD THAT CANNOT FIND ITS REPOSITORY MUST SAY SO, NOT REPORT GREEN.
//
// Three guards replay against a real client repository, and each named it by absolute path:
// `/home/bradleyjerome/projects/metrolinx/next.metrolinx.com`, wrapped in
// `it.runIf(existsSync(REPO))`. On any other machine, in CI, or after that directory moves, every
// one of those assertions vanishes and the file reports PASSED. The guards most worth having are
// the ones that stop guarding invisibly — which is the exact defect class they were written for.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { replayRoots, replayRepo, replayTitle } from '../../support/replay-codeline';

const ROOT = join(__dirname, '../../..');

describe('the replay helper', () => {
  it('reads the roots the project configs already declare', () => {
    expect(replayRoots().length, 'no JIRA_CODELINE_ROOT found — the replay guards would all skip')
      .toBeGreaterThan(0);
  });

  it('reports no repository for a name nothing declares', () => {
    expect(replayRepo('no-such-repository-anywhere')).toBe('');
  });

  it('states the reason in the title when a repository is missing', () => {
    expect(replayTitle('some guard', '', 'some.repo')).toMatch(/SKIPPED/);
  });

  it('an available repository keeps its plain title', () => {
    expect(replayTitle('some guard', '/somewhere/real', 'some.repo')).toBe('some guard');
  });
});

describe('the replay guards themselves', () => {
  const REPLAY_TESTS = [
    'brownfield-cve-hard-stopped-on-existing-debt',
    'manifest-and-lockfile-drifted-apart',
    'helper-gate-judged-by-real-diffs',
  ];

  it('name no absolute home path', () => {
    const offenders: string[] = [];
    for (const t of REPLAY_TESTS) {
      const body = readFileSync(join(ROOT, `test/unit/orchestration/${t}.test.ts`), 'utf8');
      const hits = body.split('\n')
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /['"]\/home\/[^'"]+/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      for (const h of hits) offenders.push(`${t}.test.ts:${h.n}: ${h.l.trim().slice(0, 70)}`);
    }
    expect(offenders, `a replay guard hardcodes a machine-specific path:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('go through the shared helper, so the skip reason is always stated', () => {
    for (const t of REPLAY_TESTS) {
      const body = readFileSync(join(ROOT, `test/unit/orchestration/${t}.test.ts`), 'utf8');
      expect(body, `${t} does not use the replay helper`).toMatch(/replay-codeline/);
    }
  });
});
