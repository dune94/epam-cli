/**
 * wireSplitSiblingDependencies / reorderSiblingsByDependency — deterministic
 * dependency wiring for split impl/test story pairs.
 *
 * Root cause this fixes (found live, 2026-07-09, tier3-travel-app run): a
 * split child's `dependencies` array comes straight from the LLM's own split
 * proposal — nothing deterministically cross-referenced a test-only sibling
 * to its impl sibling from the SAME split. Downstream, claude.sh's
 * deterministic dependency-contract injection (build_implementation_prompt,
 * run_failure_analyst) and are_dependencies_satisfied() gate ONLY on
 * `.dependencies`/`.technicalNotes.dependsOn` — so a test child never
 * received its impl sibling's real (regex-extracted) exported signatures, on
 * its first attempt OR any retry. Confirmed live: SKY-003-test/-test-1 and
 * SKY-004-test all had `dependencies: []` despite an obvious impl sibling,
 * and burned 7+ healing cycles guessing at shifting surface symptoms instead
 * of ever seeing the real contract.
 *
 * Same design as correctSplitChildAgentRoleIfTestOnly (see
 * split-enforcement.test.ts): config supplies stack knowledge
 * (testFilePattern/sourceExtensions from .epam/contract-generation.json),
 * the engine has none.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireSplitSiblingDependencies, reorderSiblingsByDependency } = require(
  '../../../orchestrations/scripts/spec-mode-runner.js'
);
const SPEC_MODE_RUNNER_SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
  'utf8'
);

const CONFIG = {
  testFilePattern: '\\.(test|spec)\\.[a-zA-Z0-9]+$',
  sourceExtensions: ['.ts'],
};

function withProjectConfig(cfg: object | null, fn: (outputDir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sibling-dep-wiring-test-'));
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

describe('wireSplitSiblingDependencies — deterministic, config-driven sibling wiring', () => {
  it('REPRODUCES the exact live defect and proves the fix: a test-only sibling gets its impl sibling wired as a dependency', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const implSibling = {
        id: 'SKY-003-impl',
        dependencies: [],
        technicalNotes: { files: ['/x/src/cli.ts'] },
      };
      const testSibling = {
        id: 'SKY-003-test',
        dependencies: [],
        technicalNotes: { files: ['/x/src/cli.test.ts'] },
        specification: { createdFrom: 'SKY-003' },
      };
      wireSplitSiblingDependencies([implSibling, testSibling], prd);
      expect(testSibling.dependencies).toEqual(['SKY-003-impl']);
      expect(implSibling.dependencies).toEqual([]); // impl sibling untouched
    });
  });

  it('does NOT wire a test sibling to a non-matching impl sibling (different basename)', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const implSibling = {
        id: 'SKY-003-impl',
        dependencies: [],
        technicalNotes: { files: ['/x/src/server.ts'] },
      };
      const testSibling = {
        id: 'SKY-003-test',
        dependencies: [],
        technicalNotes: { files: ['/x/src/cli.test.ts'] },
      };
      wireSplitSiblingDependencies([implSibling, testSibling], prd);
      expect(testSibling.dependencies).toEqual([]);
    });
  });

  it('does not overwrite an already-populated dependencies array, only adds missing matches', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const implSibling = { id: 'SKY-003-impl', technicalNotes: { files: ['/x/src/cli.ts'] } };
      const testSibling = {
        id: 'SKY-003-test',
        dependencies: ['SOME-OTHER-DEP'],
        technicalNotes: { files: ['/x/src/cli.test.ts'] },
      };
      wireSplitSiblingDependencies([implSibling, testSibling], prd);
      expect(testSibling.dependencies.sort()).toEqual(['SKY-003-impl', 'SOME-OTHER-DEP'].sort());
    });
  });

  it('wires a test sibling to MULTIPLE matching impl siblings when more than one file basename matches', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const implA = { id: 'SKY-003-impl-a', technicalNotes: { files: ['/x/src/cli.ts'] } };
      const implB = { id: 'SKY-003-impl-b', technicalNotes: { files: ['/x/src/server.ts'] } };
      const testSibling = {
        id: 'SKY-003-test',
        dependencies: [],
        technicalNotes: { files: ['/x/src/cli.test.ts', '/x/src/server.test.ts'] },
      };
      wireSplitSiblingDependencies([implA, implB, testSibling], prd);
      expect(testSibling.dependencies.sort()).toEqual(['SKY-003-impl-a', 'SKY-003-impl-b']);
    });
  });

  it('does not treat another test sibling as an impl dependency', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const testA = { id: 'SKY-003-test-a', dependencies: [], technicalNotes: { files: ['/x/src/cli.test.ts'] } };
      const testB = { id: 'SKY-003-test-b', dependencies: [], technicalNotes: { files: ['/x/src/cli.test.ts'] } };
      wireSplitSiblingDependencies([testA, testB], prd);
      expect(testA.dependencies).toEqual([]);
      expect(testB.dependencies).toEqual([]);
    });
  });

  it('is a no-op when .epam/contract-generation.json does not exist', () => {
    withProjectConfig(null, (outputDir) => {
      const prd = { project: { outputDir } };
      const implSibling = { id: 'SKY-003-impl', technicalNotes: { files: ['/x/src/cli.ts'] } };
      const testSibling = { id: 'SKY-003-test', dependencies: [], technicalNotes: { files: ['/x/src/cli.test.ts'] } };
      wireSplitSiblingDependencies([implSibling, testSibling], prd);
      expect(testSibling.dependencies).toEqual([]);
    });
  });

  it('is a no-op when the config lacks testFilePattern/sourceExtensions (opt-in, no engine default)', () => {
    withProjectConfig({ someOtherKey: true }, (outputDir) => {
      const prd = { project: { outputDir } };
      const implSibling = { id: 'SKY-003-impl', technicalNotes: { files: ['/x/src/cli.ts'] } };
      const testSibling = { id: 'SKY-003-test', dependencies: [], technicalNotes: { files: ['/x/src/cli.test.ts'] } };
      wireSplitSiblingDependencies([implSibling, testSibling], prd);
      expect(testSibling.dependencies).toEqual([]);
    });
  });

  it('is a no-op with fewer than 2 siblings', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const testSibling = { id: 'SKY-003-test', dependencies: [], technicalNotes: { files: ['/x/src/cli.test.ts'] } };
      wireSplitSiblingDependencies([testSibling], prd);
      expect(testSibling.dependencies).toEqual([]);
    });
  });

  it('the engine source itself contains no hardcoded ".test.ts" literal in this function — only reads the pattern from config', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('function wireSplitSiblingDependencies');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\n}', SPEC_MODE_RUNNER_SRC.indexOf('\n}', idx) + 1) + 2;
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(body).not.toMatch(/'\\.test\\.ts'|"\.test\.ts"/);
    expect(body).toMatch(/cfg\.testFilePattern/);
    expect(body).toMatch(/cfg\.sourceExtensions/);
  });
});

describe('reorderSiblingsByDependency — keeps a dependency ahead of its dependent in implementationOrder', () => {
  it('REPRODUCES the exact live risk and proves the fix: a test sibling ordered BEFORE its newly-wired impl dependency gets moved after it', () => {
    const order = ['SKY-003-test', 'SKY-003-impl'];
    const siblings = [
      { id: 'SKY-003-impl' },
      { id: 'SKY-003-test', dependencies: ['SKY-003-impl'] },
    ];
    reorderSiblingsByDependency(siblings, order);
    expect(order.indexOf('SKY-003-impl')).toBeLessThan(order.indexOf('SKY-003-test'));
  });

  it('is a no-op when already correctly ordered', () => {
    const order = ['SKY-003-impl', 'SKY-003-test'];
    const siblings = [
      { id: 'SKY-003-impl' },
      { id: 'SKY-003-test', dependencies: ['SKY-003-impl'] },
    ];
    reorderSiblingsByDependency(siblings, order);
    expect(order).toEqual(['SKY-003-impl', 'SKY-003-test']);
  });

  it('does not reorder based on a dependency OUTSIDE the sibling group', () => {
    const order = ['SKY-003-test', 'OTHER-STORY', 'SKY-003-impl'];
    const siblings = [
      { id: 'SKY-003-impl' },
      { id: 'SKY-003-test', dependencies: ['OTHER-STORY'] },
    ];
    reorderSiblingsByDependency(siblings, order);
    expect(order).toEqual(['SKY-003-test', 'OTHER-STORY', 'SKY-003-impl']);
  });
});

describe('wireSplitSiblingDependencies + reorderSiblingsByDependency — wired into both split-creation sites', () => {
  it('the spec-pass insertion block (Step 3) calls both functions after grouping newStories by parentId', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('// ── Step 3: Insert split stories into PRD');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\n  }\n\n  // ── Step 4:', idx);
    const block = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(block).toMatch(/wireSplitSiblingDependencies\(siblings, prd\)/);
    expect(block).toMatch(/reorderSiblingsByDependency\(siblings, wiringOrder\)/);
  });

  it('validateMidExecutionSplits (mid-execution split path) calls both functions after the coherence check, before speckit review', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('async function validateMidExecutionSplits');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\nif (require.main === module)', idx);
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(body).toMatch(/wireSplitSiblingDependencies\(children, prd\)/);
    expect(body).toMatch(/reorderSiblingsByDependency\(children, prd\.implementationOrder\?\.\[phase\]\)/);
    const coherenceIdx = body.indexOf('same-file coherence violation');
    const wireIdx = body.indexOf('wireSplitSiblingDependencies(children, prd)');
    const speckitIdx = body.indexOf('runSpeckitReview');
    expect(wireIdx).toBeGreaterThan(coherenceIdx);
    expect(wireIdx).toBeLessThan(speckitIdx);
  });
});
