/**
 * A GATE THAT CLAIMS TO REPRODUCE THE HOOK MUST LINT WHAT THE HOOK LINTS.
 *
 * run_repo_lint_verification runs the repository's own eslint over every changed file and reports
 * "the pre-commit hook will refuse this commit and lint-staged will REVERT the work". Live
 * 2026-08-10 on next.gotransit.com it failed a story on exactly two files:
 *
 *     package.json       1:1  error  Expected an assignment or function call  (no-unused-expressions)
 *     package-lock.json  1:1  error  Expected an assignment or function call  (no-unused-expressions)
 *
 * That is eslint parsing JSON as TypeScript. The repo's real routing says it never sees them:
 *
 *     "src/**\/*.(ts|js)?(x)": (f) => [`eslint ${f.join(" ")}`, `prettier --write ...`]
 *     "**\/*.(md|json|html)":  "prettier --write --ignore-unknown"
 *
 * JSON goes to prettier. eslint runs on src/**\/*.{ts,tsx,js,jsx} only. The gate was stricter than
 * the hook it claimed to predict, and blocked a story over files the writer had to change to add a
 * dependency — work it could not have made lint-clean because the linter should never have run.
 *
 * The old selection asked `eslint --print-config <file>`, which returns a config for ANY path under
 * flat config — including JSON. "Does a config exist" is not "does the hook lint this".
 *
 * NO STACK FACTS. Nothing here names an extension, a language, a framework or a file. The routing
 * comes from the repository's own lint-staged declaration, and matching uses the repository's OWN
 * matcher, so a repo that routes .vue, .svelte or .py is correct without this code knowing those
 * exist. A repo that declares no routing yields UNKNOWN, and the caller keeps its previous
 * behaviour rather than being handed a fabricated answer.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCOPE = join(ROOT, 'orchestrations/scripts/lib/lint-staged-scope.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * A repo with a lint-staged declaration and the matcher lint-staged itself uses.
 * micromatch is symlinked from this repo's own node_modules so the fixture has a real one.
 */
function repo(lintStaged: string | null, opts: { withMatcher?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lintscope-')); dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
  if (lintStaged !== null) writeFileSync(join(dir, '.lintstagedrc.js'), lintStaged);
  if (opts.withMatcher !== false) {
    const src = join(ROOT, 'node_modules/micromatch');
    if (existsSync(src)) {
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      try { symlinkSync(src, join(dir, 'node_modules/micromatch'), 'dir'); } catch { /* exists */ }
    }
  }
  return dir;
}

/** Run the scope helper: stdin = changed paths, argv = repo + tool basename. */
function scope(dir: string, tool: string, paths: string[]): { out: string[]; code: number } {
  try {
    const out = execFileSync('node', [SCOPE, dir, tool], {
      input: paths.join('\n'), encoding: 'utf8',
    });
    return { out: out.split('\n').filter(Boolean), code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { out: (err.stdout ?? '').split('\n').filter(Boolean), code: err.status ?? 1 };
  }
}

// The routing that produced the live failure, verbatim in shape.
const REAL_ROUTING = `module.exports = {
  "src/**/*.ts?(x)": () => "npm run check-types",
  "src/**/*.(ts|js)?(x)": (filenames) => [
    \`eslint \${filenames.join(" ")}\`,
    \`prettier --write --ignore-unknown \${filenames.join(" ")}\`,
  ],
  "**/*.(md|json|html)": "prettier --write --ignore-unknown",
  "src/**/*.css": ["stylelint", "prettier --write --ignore-unknown"],
};`;

describe('the helper exists and can be executed', () => {
  it('the scope helper is present', () => {
    expect(existsSync(SCOPE), 'lib/lint-staged-scope.js does not exist').toBe(true);
  });
});

describe('THE LIVE FAILURE: files the hook routes elsewhere are not linted', () => {
  it('JSON routed to a different tool is EXCLUDED from the linter', () => {
    const d = repo(REAL_ROUTING);
    const { out } = scope(d, 'eslint', ['package.json', 'package-lock.json', 'src/a.ts']);
    expect(
      out,
      'package.json/package-lock.json route to prettier, never eslint — linting them is what ' +
      'failed a story on a parse error the real hook would never produce',
    ).toEqual(['src/a.ts']);
  });

  it('source files the hook DOES route to the linter are included', () => {
    const d = repo(REAL_ROUTING);
    const { out } = scope(d, 'eslint', ['src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx']);
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.jsx'].sort());
  });

  it('a file matching NO glob is excluded', () => {
    // .env.local.sample matched nothing and eslint reported "File ignored by default".
    const d = repo(REAL_ROUTING);
    const { out } = scope(d, 'eslint', ['.env.local.sample']);
    expect(out).toEqual([]);
  });

  it('a file outside the routed directory is excluded even with a routed extension', () => {
    // The globs are rooted at src/. A .ts file elsewhere is not linted by this hook.
    const d = repo(REAL_ROUTING);
    const { out } = scope(d, 'eslint', ['scripts/tool.ts']);
    expect(out).toEqual([]);
  });

  it('routing is per TOOL, not per file — the same file can belong to another tool', () => {
    const d = repo(REAL_ROUTING);
    expect(scope(d, 'stylelint', ['src/x.css', 'src/a.ts']).out).toEqual(['src/x.css']);
    expect(scope(d, 'prettier', ['package.json']).out).toEqual(['package.json']);
  });
});

describe('ABSENT MUST NOT BECOME A FABRICATED ANSWER', () => {
  it('a repo with no lint-staged declaration reports UNKNOWN, not "nothing to lint"', () => {
    // Returning an empty set would silently disable the gate for every repo without lint-staged.
    const d = repo(null);
    const { out, code } = scope(d, 'eslint', ['src/a.ts']);
    expect(out, 'it invented a selection for a repo that declares no routing').toEqual([]);
    expect(code, 'UNKNOWN must be distinguishable from "no files match"').not.toBe(0);
  });

  it('a declaration that cannot be read reports UNKNOWN rather than an empty selection', () => {
    const d = repo('module.exports = ');   // syntax error
    const { code } = scope(d, 'eslint', ['src/a.ts']);
    expect(code).not.toBe(0);
  });

  it('a repo without the matcher reports UNKNOWN rather than guessing at glob semantics', () => {
    // Hand-rolling extglob (?(x), (ts|js)) is how the semantics drift from the hook's.
    const d = repo(REAL_ROUTING, { withMatcher: false });
    const { code } = scope(d, 'eslint', ['src/a.ts']);
    expect(code).not.toBe(0);
  });
});

describe('no stack facts entered the engine', () => {
  it('the helper names no extension, language or tool', () => {
    const src = require('node:fs').readFileSync(SCOPE, 'utf8');
    const code = src.split('\n')
      .filter((l: string) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    for (const banned of ['.ts', '.tsx', '.json"', 'eslint', 'prettier', 'stylelint', 'typescript']) {
      expect(code, `'${banned}' is hardcoded — routing is a REPOSITORY fact`).not.toContain(banned);
    }
  });
});

describe('THE GATE ITSELF uses the scope helper, not the permissive probe', () => {
  const src = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
  const fn = src.slice(
    src.indexOf('run_repo_lint_verification() {'),
    src.indexOf('\n}\n', src.indexOf('run_repo_lint_verification() {')),
  );

  it('the gate calls the scope helper', () => {
    expect(fn, 'the gate never consults the repo routing').toContain('lint-staged-scope.js');
  });

  it('an EMPTY answer means lint nothing, not lint everything', () => {
    // The whole defect: falling back on an empty-but-valid answer re-lints the JSON files.
    expect(fn).toMatch(/_scope_rc.*-eq 0|_scope_rc" -eq 0/);
  });

  it('UNKNOWN still falls back to the previous selection rather than disabling the gate', () => {
    expect(fn, 'a repo with no declaration would silently stop being linted').toContain('--print-config');
  });
});
