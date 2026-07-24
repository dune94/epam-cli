/**
 * Brownfield test-coverage gate — REAL execution of the actual exported
 * codegraph-context.js functions, real `codegraph` binary, real fixture repo.
 *
 * Brownfield testing strategy (distinct from greenfield): the agent MODIFIES
 * existing code. Existing tests must still pass (the Step 5 regression guard +
 * Step 4.5 unit gate already run the codeline's full suite for that). A NEW
 * test is warranted ONLY for a changed file that has NO covering tests — never
 * speculative "wild tests". This gate makes that decision deterministically
 * via CodeGraph's `affected` command: empty affected-test set → uncovered →
 * one targeted test; non-empty → already covered → no new test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cg = require('../../../orchestrations/scripts/lib/codegraph-context.js');

function codegraphAvailable(): boolean {
  try { execSync('command -v codegraph', { stdio: 'ignore' }); return true; } catch { return false; }
}

const cleanupDirs: string[] = [];
afterAll(() => { for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A repo with ONE covered source file (has a colocated .test.ts that imports it)
// and ONE uncovered source file (no test references it).
function makeMixedCoverageRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'coverage-gate-'));
  cleanupDirs.push(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });

  writeFileSync(join(repo, 'src', 'covered.ts'), `export function coveredFn(x: number) { return x + 1; }\n`);
  writeFileSync(
    join(repo, 'src', 'covered.test.ts'),
    `import { coveredFn } from './covered';\nimport { describe, it, expect } from 'vitest';\ndescribe('coveredFn', () => { it('adds', () => { expect(coveredFn(1)).toBe(2); }); });\n`,
  );
  writeFileSync(join(repo, 'src', 'uncovered.ts'), `export function uncoveredFn(x: number) { return x * 2; }\n`);

  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'seed']);
  execSync(`codegraph init "${repo}"`, { stdio: 'ignore' });
  return repo;
}

describe('brownfield coverage gate (real codegraph, real fixture)', () => {
  it('flags a changed file with NO covering tests as needing a targeted test', () => {
    if (!codegraphAvailable()) return;
    const repo = makeMixedCoverageRepo();
    const uncovered = cg.uncoveredChangedFiles(['src/uncovered.ts', 'src/covered.ts'], repo);
    expect(uncovered).toContain('src/uncovered.ts');
    expect(uncovered).not.toContain('src/covered.ts');
  }, 30000);

  it('does NOT flag an already-covered changed file (no wild tests)', () => {
    if (!codegraphAvailable()) return;
    const repo = makeMixedCoverageRepo();
    expect(cg.affectedTestFiles('src/covered.ts', repo).length).toBeGreaterThan(0);
    expect(cg.affectedTestFiles('src/uncovered.ts', repo).length).toBe(0);
  }, 30000);

  it('ignores test files themselves and non-code files as change candidates', () => {
    if (!codegraphAvailable()) return;
    const repo = makeMixedCoverageRepo();
    const uncovered = cg.uncoveredChangedFiles(
      ['src/uncovered.ts', 'src/covered.test.ts', 'README.md', 'src/__tests__/x.test.ts'],
      repo,
    );
    // Only the real, uncovered impl file — never the test files or docs.
    expect(uncovered).toEqual(['src/uncovered.ts']);
  }, 30000);

  it('self-heals an unindexed-but-indexable repo (ensureIndexed) rather than returning null — the coverage decision is still made', () => {
    if (!codegraphAvailable()) return;
    const repo = mkdtempSync(join(tmpdir(), 'coverage-noindex-'));
    cleanupDirs.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
    // No index yet — but uncoveredChangedFiles now calls ensureIndexed, which
    // builds the index on demand, so it returns a real decision (an array),
    // NOT null. a.ts has no test → it's uncovered.
    const result = cg.uncoveredChangedFiles(['src/a.ts'], repo);
    expect(result).not.toBeNull();
    expect(result).toEqual(['src/a.ts']);
    expect(cg.isCodeGraphIndexed(repo)).toBe(true); // was indexed on demand
  }, 30000);

  it('returns null (cannot-determine) ONLY when CodeGraph genuinely cannot index (binary unresolvable via CODEGRAPH_BIN)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'coverage-nobin-'));
    cleanupDirs.push(repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
    const prev = process.env.CODEGRAPH_BIN;
    process.env.CODEGRAPH_BIN = '/nonexistent/codegraph-binary';
    try {
      expect(cg.uncoveredChangedFiles(['src/a.ts'], repo)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_BIN; else process.env.CODEGRAPH_BIN = prev;
    }
  });
});
