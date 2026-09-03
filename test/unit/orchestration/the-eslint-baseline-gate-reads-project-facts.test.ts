/**
 * THE ESLINT BASELINE GATE, EXECUTED — IT HAD NEVER BEEN RUN AT ALL.
 *
 * 383 lines, 0% covered. Not "lightly tested": no test in this repository had ever executed a line
 * of it, and it decides whether a story's lint findings block a phase.
 *
 * Its own header records the defects it was written to fix, and every one is a fail-open — a gate
 * that examined nothing and reported a verdict:
 *
 *   - which extensions are lintable was a literal list of ten from one ecosystem, so a repo it
 *     could not parse got PASS
 *   - the project root was read from the $PROJECT_ROOT global instead of the threaded parameter,
 *     which its callers do not set: the extension list came back empty, nothing was lintable, and
 *     the gate passed everything
 *   - source roots and vendor directories were hardcoded to src/ and node_modules/, so a repo whose
 *     sources sit elsewhere matched nothing
 *   - vendor pruning required the vendored directory to exist AT THE ROOT, so a repo whose only
 *     copy is nested had nothing pruned, a .js file belonging to a DEPENDENCY decided that .js was
 *     a project source extension, and eslint was handed `src/**` globs for a TypeScript project
 *
 * Each is asserted here against a fixture project, by calling the real functions from the real
 * file. A fail-open is invisible in a passing run — the only way to see one is to execute the gate
 * against a repo it should have said something about.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/eslint-baseline-gate.sh');

/**
 * Source the real library and run one expression against it. PROJECT_ROOT is deliberately left
 * unset: its callers do not set it, and reading it instead of the threaded parameter is one of the
 * defects under test.
 */
function ask(expr: string, cwd = REPO): { out: string; status: number | null } {
  const r = spawnSync('bash', ['-c', `set +e; . ${JSON.stringify(LIB)}; ${expr}`], {
    encoding: 'utf8', timeout: 60000, cwd,
    // INHERIT THE ENVIRONMENT, THEN UNSET ONLY WHAT IS UNDER TEST.
    //
    // A hand-built { PATH, HOME } looks like careful isolation and silently defeats measurement:
    // the shell coverage collector instruments children through BASH_ENV and BASH_XTRACEFD, so
    // replacing the environment strips the instrumentation and every line this suite executes is
    // invisible. Eight passing tests moved the gates stage by 0.0 points until this was fixed.
    env: (() => { const e: any = { ...process.env }; delete e.PROJECT_ROOT; return e; })(),
  });
  return { out: (r.stdout || '').trim(), status: r.status };
}

/** A project that declares its own facts, in the file the gate actually reads. */
function project(facts: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'eslint-gate-'));
  if (facts) {
    mkdirSync(join(root, '.epam'), { recursive: true });
    writeFileSync(join(root, '.epam/dependency-check.json'), JSON.stringify(facts));
  }
  return root;
}

describe('the eslint baseline gate reads project facts', () => {
  it('the library sources cleanly and defines its helpers', () => {
    // Vacuity guard: if sourcing failed, every assertion below would compare empty to empty.
    const r = ask('type -t _eslint_lintable_exts _eslint_is_lintable _eslint_tree_globs '
      + '_eslint_vendor_dir_names _eslint_source_roots eslint_baseline_gate');
    expect(r.out.split('\n').filter((l) => l === 'function').length,
      `not all helpers are defined:\n${r.out}`).toBe(6);
  }, 70_000);

  it('lintable extensions come from the project, with the leading dot stripped', () => {
    const root = project({ scanFileExtensions: ['.ts', '.tsx'] });
    expect(ask(`_eslint_lintable_exts ${JSON.stringify(root)}`).out).toBe('ts tsx');
  }, 70_000);

  it('a project declaring none gets NOTHING — never a guessed list', () => {
    // The fail-open in its purest form: a guessed list makes the gate examine files it was never
    // told about, and report a verdict about a language the project does not use.
    const root = project({});
    expect(ask(`_eslint_lintable_exts ${JSON.stringify(root)}`).out).toBe('');
    const bare = project(null);
    expect(ask(`_eslint_lintable_exts ${JSON.stringify(bare)}`).out).toBe('');
  }, 70_000);

  it('THE SCOPING SLIP: the root is threaded, not read from $PROJECT_ROOT', () => {
    // With the global unset — as in its real callers — reading it made the extension list empty,
    // nothing was lintable, and the gate passed everything.
    const root = project({ scanFileExtensions: ['.ts'] });
    expect(ask(`_eslint_is_lintable src/a.ts ${JSON.stringify(root)}; echo "rc=$?"`).out)
      .toContain('rc=0');
    expect(ask(`_eslint_is_lintable src/a.py ${JSON.stringify(root)}; echo "rc=$?"`).out)
      .toContain('rc=1');
  }, 70_000);

  it('paths the pipeline itself writes are never story output', () => {
    const r = ask('printf %s "$_ESLINT_INCIDENTAL_RE"');
    expect(r.out, 'the incidental pattern is gone').not.toBe('');
    for (const p of ['.codegraph/graph.json', '.epam/settings.json']) {
      const m = ask(`printf %s "${p}" | grep -qE "$_ESLINT_INCIDENTAL_RE" && echo yes || echo no`);
      expect(m.out, `${p} is pipeline output and must not count as a story finding`).toBe('yes');
    }
    const m = ask('printf %s "src/app.ts" | grep -qE "$_ESLINT_INCIDENTAL_RE" && echo yes || echo no');
    expect(m.out, 'real source was classified as pipeline output').toBe('no');
  }, 70_000);

  it('vendor directories match by BASENAME, so a nested copy is still pruned', () => {
    // The defect: pruning required the directory to exist at the root, so a repo whose only
    // vendored copy is nested had nothing pruned — and a dependency's .js decided the project's
    // source extensions.
    const root = project({ vendorDirs: ['packages/web/node_modules'] });
    expect(ask(`_eslint_vendor_dir_names ${JSON.stringify(root)}`).out).toBe('node_modules');
  }, 70_000);

  it('tree globs cover declared source roots that exist, and only extensions really present', () => {
    const root = project({ scanFileExtensions: ['.ts', '.js'], moduleRoots: ['lib', 'absent'],
      vendorDirs: ['node_modules'] });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib/a.ts'), 'export const a = 1;\n');
    const out = ask(`_eslint_tree_globs ${JSON.stringify(root)}`).out.split('\n').filter(Boolean);
    expect(out, 'the declared, existing source root with a .ts in it was not covered')
      .toContain('lib/**/*.ts');
    expect(out, 'a .js glob was emitted though the tree contains no .js at all')
      .not.toContain('lib/**/*.js');
    expect(out.some((g) => g.startsWith('absent/')),
      'a source root that does not exist was globbed anyway').toBe(false);
  }, 70_000);

  it('AND A VENDORED FILE DOES NOT DECIDE THE PROJECT\'S EXTENSIONS', () => {
    // The exact shape of the live defect: the only .js in the tree belongs to a nested dependency.
    // Unpruned, it makes .js look like a project source extension for a TypeScript project.
    const root = project({ scanFileExtensions: ['.ts', '.js'], moduleRoots: ['src'],
      vendorDirs: ['node_modules'] });
    mkdirSync(join(root, 'src/node_modules/dep'), { recursive: true });
    writeFileSync(join(root, 'src/app.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src/node_modules/dep/index.js'), 'module.exports = 1;\n');
    const out = ask(`_eslint_tree_globs ${JSON.stringify(root)}`).out.split('\n').filter(Boolean);
    expect(out, 'the TypeScript source root was not covered').toContain('src/**/*.ts');
    expect(out, 'a dependency\'s .js was treated as project source')
      .not.toContain('src/**/*.js');
  }, 70_000);
});
