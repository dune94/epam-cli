/**
 * Step 20 lint gate — the eslint invocation must be able to see the project's
 * source files at all.
 *
 * Live metrolinx 2026-07-25. The gate ran `eslint src/ --max-warnings 0`.
 * ESLint expands a bare DIRECTORY argument using `--ext`, which defaults to
 * `.js` (and was removed outright in ESLint 9). The codeline's `src/` holds 852
 * `.ts` files and zero `.js`, so the pattern matched nothing:
 *
 *     No files matching the pattern "src/" were found.
 *     [ERROR]   [lint] eslint: FAIL (exit 2)
 *     [ERROR] [orch] Phase 'core' for 'cdts' failed (exit 1)
 *
 * The story had already been implemented, tested and committed. The gate that
 * killed the run was not reporting on the code at all — it could never pass on
 * a TypeScript repository regardless of what the agents wrote, because a
 * JS-shaped stack assumption was hardcoded into the engine.
 *
 * Target derivation now lives in lib/eslint-baseline-gate.sh (_eslint_tree_globs,
 * used for the greenfield whole-tree scope), so this file tests it there. The
 * scoped/brownfield behaviour is pinned in eslint-baseline-gate.test.ts; what
 * is pinned HERE is narrower and is the part that actually killed the run:
 * whatever the gate hands ESLint must match the files that exist, and must
 * never include a file ESLint cannot parse.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const GATE_LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/eslint-baseline-gate.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lint-targets-'));
  cleanupDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** The targets the gate would hand ESLint for a whole-tree (greenfield) scope. */
function derivedTargets(projectRoot: string): string[] {
  const r = spawnSync(
    'bash',
    ['-c', `. ${JSON.stringify(GATE_LIB)}; _eslint_tree_globs ${JSON.stringify(projectRoot)}`],
    { encoding: 'utf8', timeout: 20000 },
  );
  return (r.stdout || '').split('\n').filter(Boolean);
}

/**
 * Does ESLint's real directory-vs-glob semantics match anything here? Mirrors
 * ESLint 8: a bare directory is expanded with --ext (default .js); a glob is
 * expanded as a glob.
 */
function eslintWouldMatch(projectRoot: string, targets: string[]): number {
  const script = `
import sys, os, glob
root, targets = sys.argv[1], sys.argv[2:]
os.chdir(root)
n = 0
for t in targets:
    if os.path.isdir(t):
        n += len([f for f in glob.glob(os.path.join(t, '**', '*.js'), recursive=True) if os.path.isfile(f)])
    else:
        n += len([f for f in glob.glob(t, recursive=True) if os.path.isfile(f)])
print(n)
`;
  const r = spawnSync('python3', ['-c', script, projectRoot, ...targets], { encoding: 'utf8', timeout: 20000 });
  return parseInt((r.stdout || '0').trim(), 10);
}

describe('the gate lints the files that are actually there', () => {
  it('matches a TypeScript-only tree instead of nothing — the metrolinx shape', () => {
    const root = makeTree({
      'src/index.ts': 'export const a = 1;\n',
      'src/services/thing.ts': 'export const b = 2;\n',
    });
    const targets = derivedTargets(root);

    expect(targets.length, 'no lint target was derived for a TypeScript tree').toBeGreaterThan(0);
    expect(eslintWouldMatch(root, targets),
      'ESLint would match zero files — this is exactly "No files matching the pattern src/", ' +
      'a gate that can never pass on a TypeScript repo no matter what the agents wrote')
      .toBe(2);
  });

  it('uses globs, never a bare directory (ESLint 9 has no --ext at all)', () => {
    const root = makeTree({ 'src/index.ts': 'export const a = 1;\n' });
    const targets = derivedTargets(root);

    expect(targets.every(t => /\*/.test(t)),
      `a non-glob target was derived; its meaning depends on --ext, which defaults ` +
      `to .js in ESLint 8 and does not exist in ESLint 9. Targets: ${JSON.stringify(targets)}`)
      .toBe(true);
    expect(targets).not.toContain('src/');
  });

  it('covers every lintable extension present, not just one', () => {
    const root = makeTree({
      'src/legacy.js': 'module.exports = {};\n',
      'src/index.ts': 'export const a = 1;\n',
      'src/view.tsx': 'export const V = () => null;\n',
    });
    const joined = derivedTargets(root).join(' ');

    expect(joined, 'no .ts target').toMatch(/\*\.ts(\s|$)/);
    expect(joined, 'no .tsx target').toMatch(/\*\.tsx(\s|$)/);
    expect(joined, 'no .js target').toMatch(/\*\.js(\s|$)/);
  });

  it('derives no target for an extension that is not present', () => {
    const root = makeTree({ 'src/index.ts': 'export const a = 1;\n' });
    expect(derivedTargets(root).join(' '),
      'a .js target was derived for a tree with no .js files — ESLint exits 2 ' +
      'on a pattern that matches nothing, failing the gate over an empty set')
      .not.toMatch(/\*\.js(\s|$)/);
  });

  it('does not hand ESLint files it cannot parse (snapshots, markdown)', () => {
    const root = makeTree({
      'src/index.ts': 'export const a = 1;\n',
      'src/__snapshots__/thing.spec.ts.snap': '// Jest Snapshot v1\n',
      'src/README.md': '# docs\n',
    });
    const joined = derivedTargets(root).join(' ');

    expect(joined, 'a .snap target was derived — ESLint cannot parse it').not.toMatch(/\.snap/);
    expect(joined, 'a .md target was derived — ESLint cannot parse it').not.toMatch(/\.md/);
  });

  it('ignores node_modules when deciding which extensions exist', () => {
    const root = makeTree({
      'src/index.ts': 'export const a = 1;\n',
      'src/node_modules/dep/index.js': 'module.exports = 1;\n',
    });
    expect(derivedTargets(root).join(' '),
      'a .js target was derived from a vendored dependency rather than from project source')
      .not.toMatch(/\*\.js(\s|$)/);
  });

  it('derives nothing at all when the tree holds nothing lintable', () => {
    // The caller reads an empty target list as SKIP, not as failure — see
    // eslint-baseline-gate.test.ts. Handing ESLint an empty target list would
    // guarantee exit 2 and push an empty finding into the remediation pipeline.
    const root = makeTree({ 'src/README.md': '# docs only\n' });
    expect(derivedTargets(root)).toEqual([]);
  });
});
