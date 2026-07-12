/**
 * _prd_remediate_impl.py — Step 8: backfill split-sibling dependencies.
 *
 * Root cause this repairs (found live, 2026-07-09, tier3-travel-app run): a
 * split child's `dependencies` array came straight from the LLM's own split
 * proposal — nothing deterministically cross-referenced a test-only sibling
 * to its impl sibling from the SAME split. This is now fixed at split-
 * creation time in spec-mode-runner.js (wireSplitSiblingDependencies), but
 * PRDs split BEFORE that fix shipped (e.g. the live SKY-003-test/SKY-004-test
 * case) still have empty `dependencies` — this step retroactively repairs
 * those using the identical basename-matching algorithm, so a fresh
 * spec-pass is not required to pick up the fix.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const IMPL_PY = join(REPO_ROOT, 'orchestrations/scripts/_prd_remediate_impl.py');

function runRemediate(prd: object, outputDir: string, phase?: string): { exitCode: number; stdout: string; prdAfter: any } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-backfill-'));
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd));
  try {
    const args = phase ? [IMPL_PY, prdPath, phase] : [IMPL_PY, prdPath];
    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync('python3', args, { encoding: 'utf8' });
    } catch (e: any) {
      exitCode = e.status ?? -1;
      stdout = (e.stdout ?? '').toString() + (e.stderr ?? '').toString();
    }
    const prdAfter = JSON.parse(readFileSync(prdPath, 'utf8'));
    return { exitCode, stdout, prdAfter };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withProjectConfig(cfg: object | null, fn: (outputDir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-project-'));
  try {
    if (cfg) {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam/contract-generation.json'), JSON.stringify(cfg));
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONFIG = {
  testFilePattern: '\\.(test|spec)\\.[a-zA-Z0-9]+$',
  sourceExtensions: ['.ts'],
};

function baseFixture(outputDir: string) {
  return {
    project: { outputDir },
    stories: [
      {
        id: 'SKY-003-impl',
        status: 'completed',
        completed: true,
        acceptanceCriteria: ['a'],
        technicalNotes: { files: [`${outputDir}/src/cli.ts`] },
        specification: { createdFrom: 'SKY-003' },
      },
      {
        id: 'SKY-003-test',
        status: 'pending',
        completed: false,
        acceptanceCriteria: ['a'],
        technicalNotes: { files: [`${outputDir}/src/cli.test.ts`] },
        specification: { createdFrom: 'SKY-003' },
        dependencies: [],
      },
    ],
    implementationOrder: { scaffold: [], core: ['SKY-003-impl', 'SKY-003-test'] },
  };
}

describe('_prd_remediate_impl.py — Step 8 split-sibling dependency backfill (static)', () => {
  const src = readFileSync(IMPL_PY, 'utf8');

  it('the backfill step exists and reads testFilePattern/sourceExtensions from contract-generation.json', () => {
    const idx = src.indexOf('# ── 8. Backfill split-sibling dependencies');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 3000);
    expect(block).toMatch(/testFilePattern/);
    expect(block).toMatch(/sourceExtensions/);
    expect(block).not.toMatch(/'\.test\.ts'|"\.test\.ts"/);
  });
});

describe('_prd_remediate_impl.py — Step 8, REAL execution', () => {
  it('REPRODUCES the exact live defect and proves the fix: SKY-003-test with empty dependencies gets SKY-003-impl backfilled', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = baseFixture(outputDir);
      const { exitCode, prdAfter, stdout } = runRemediate(prd, outputDir, 'core');
      expect(exitCode).toBe(0);
      const testStory = prdAfter.stories.find((s: any) => s.id === 'SKY-003-test');
      expect(testStory.dependencies).toEqual(['SKY-003-impl']);
      expect(stdout).toMatch(/backfilled 1 split-sibling dependency/);
    });
  });

  it('does not touch a story that already has dependencies populated', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = baseFixture(outputDir);
      (prd.stories[1] as any).dependencies = ['SOME-OTHER-DEP'];
      const { prdAfter } = runRemediate(prd, outputDir, 'core');
      const testStory = prdAfter.stories.find((s: any) => s.id === 'SKY-003-test');
      expect(testStory.dependencies).toEqual(['SOME-OTHER-DEP']);
    });
  });

  it('is a no-op when the project has no .epam/contract-generation.json', () => {
    withProjectConfig(null, (outputDir) => {
      const prd = baseFixture(outputDir);
      const { prdAfter } = runRemediate(prd, outputDir, 'core');
      const testStory = prdAfter.stories.find((s: any) => s.id === 'SKY-003-test');
      expect(testStory.dependencies).toEqual([]);
    });
  });

  it('does not backfill siblings with non-matching basenames', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = baseFixture(outputDir);
      (prd.stories[0] as any).technicalNotes.files = [`${outputDir}/src/server.ts`];
      const { prdAfter } = runRemediate(prd, outputDir, 'core');
      const testStory = prdAfter.stories.find((s: any) => s.id === 'SKY-003-test');
      expect(testStory.dependencies).toEqual([]);
    });
  });
});
