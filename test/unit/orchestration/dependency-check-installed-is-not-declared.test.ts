/**
 * A PACKAGE BEING INSTALLED IS NOT THE SAME AS BEING DECLARED.
 *
 * Live 2026-08-09, AMSD-2041, gotransit — the first story this pipeline ever committed to a
 * client codeline, and it does not build from a clean checkout:
 *
 *     import ContentstackLivePreview from "@contentstack/live-preview-utils";
 *
 *     installed in node_modules: YES
 *     in package.json:           NO
 *     in package-lock.json:      NO
 *
 * `tsc --noEmit` passed, so every gate was satisfied — because an EARLIER, killed attempt had
 * run `npm install`, leaving the package in node_modules, which is gitignored. CI, a teammate,
 * or any fresh clone gets an unresolved import. The story was committed and undeliverable.
 *
 * run_dependency_check exists to prevent exactly this, and skipped it:
 *
 *     if os.path.isdir(os.path.join(project_root, 'node_modules', top_pkg)):
 *         continue    # "satisfiable at runtime"
 *
 * The reasoning is sound for what it was written for — a brownfield repo carrying undeclared
 * transitive deps and pre-existing installs, where rewriting package.json would be an unwanted
 * change. It is wrong for a package THIS STORY introduced: satisfiable at runtime in a directory
 * that is never committed is not satisfiable at all.
 *
 * The distinction the code needs is not "is it installed" but "did this story start importing
 * it". An import appearing in a file the story CHANGED must be declared in the manifest,
 * whatever node_modules happens to contain. An import in a file the story never touched keeps
 * the lenient treatment, because that is a pre-existing condition and not this story's business.
 *
 * This also closes a gate hole: tsc validates against whatever is in node_modules, never against
 * what the manifest can reproduce, so it will pass this defect every single time.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Synthetic. A fixture must name SOMETHING, but naming the client's real dependency
// would bake one project's stack into the engine's tests. Scoped form is deliberate:
// it exercises the @scope/name splitting the check does when building an install.
const PKG = '@fixture-scope/pkg-under-test';
const DECLARED_PKG = 'already-declared-pkg';

/**
 * A repo shaped like next.gotransit.com at the moment of the live defect: the package sits in
 * node_modules from an earlier attempt, the manifest does not declare it, and a source file
 * imports it.
 */
function repo(opts: { importInChangedFile?: boolean; importInUntouchedFile?: boolean; internalDirImport?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'depcheck-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: 'gotransit', dependencies: { [DECLARED_PKG]: '^1.0.0' } }, null, 2));
  // Pre-existing file, imports something installed-but-undeclared. Brownfield reality.
  writeFileSync(join(dir, 'src', 'legacy.ts'),
    opts.importInUntouchedFile ? `import x from "${PKG}";\nexport const l = x;\n` : 'export const l = 1;\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'baseline');

  // The package is present ONLY in gitignored node_modules — an earlier attempt installed it.
  for (const p of [PKG, DECLARED_PKG]) {
    mkdirSync(join(dir, 'node_modules', ...p.split('/')), { recursive: true });
    writeFileSync(join(dir, 'node_modules', ...p.split('/'), 'index.js'), 'x\n');
  }

  if (opts.internalDirImport) {
    // An internal path-alias import naming a DIRECTORY with no index file — the live shape in
    // next.gotransit.com, where src/components/RoutesAndDepartures/DeparturesTab/
    // DepartureDetailsSection is a directory holding .tsx files and no index.
    mkdirSync(join(dir, 'src', 'widgets', 'panel'), { recursive: true });
    writeFileSync(join(dir, 'src', 'widgets', 'panel', 'Panel.tsx'), 'export const P = 1;\n');
    writeFileSync(join(dir, 'src', 'uses-alias.ts'), 'import { P } from "widgets/panel";\nexport const u = P;\n');
  }
  // THE STORY'S CHANGE: a file it edited now imports the undeclared package.
  if (opts.importInChangedFile) {
    writeFileSync(join(dir, 'src', 'a.ts'), `import LP from "${PKG}";\nexport const a = LP;\n`);
  }

  // installCommand records instead of installing: the assertion is about what was DETECTED.
  writeFileSync(join(dir, '.epam', 'dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json',
    manifestKeys: ['dependencies', 'devDependencies'],
    scanFileExtensions: ['.ts', '.tsx', '.js'],
    installCommand: `echo {package} >> ${JSON.stringify(join(dir, 'installed.txt'))}`,
    importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]",
    ignorePackages: ['fs', 'path', 'url'],
    // Real dependency-check configs declare this, and omitting it made the fixture WRONG in a
    // way that hid the engine's behaviour: without it, node_modules becomes a discovered module
    // root, so _resolves_inside_repo() finds node_modules/<pkg>/index.js and classifies an
    // installed package as internal repo source — skipped long before the node_modules check
    // under test. The fixture must not be more permissive than the configuration it stands in for.
    vendorDirs: ['node_modules'],
  }, null, 2));
  return dir;
}

/** Runs the real run_dependency_check; returns what it decided to install. */
function depCheck(dir: string) {
  const fn = (() => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const start = src.indexOf('run_dependency_check() {');
    expect(start, 'run_dependency_check not found').toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
  })();

  const out = execFileSync('bash', ['-c',
    `set -u
     log() { echo "LOG:$*"; }; error() { echo "ERR:$*"; }
     warning() { echo "WARN:$*"; }; success() { echo "OK:$*"; }; info() { echo "INFO:$*"; }
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
${fn}
     run_dependency_check ${JSON.stringify(dir)} 2>&1; echo "RC=$?"`,
  ], { encoding: 'utf8' });

  const f = join(dir, 'installed.txt');
  return {
    out,
    installed: existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [],
  };
}

describe('the fixture reproduces the live condition', () => {
  it('the package is in node_modules, absent from the manifest, and imported', () => {
    const d = repo({ importInChangedFile: true });
    expect(existsSync(join(d, 'node_modules', ...PKG.split('/')))).toBe(true);
    expect(readFileSync(join(d, 'package.json'), 'utf8')).not.toContain(PKG);
    expect(readFileSync(join(d, 'src', 'a.ts'), 'utf8')).toContain(PKG);
  });

  it('and git reports that file as changed — the signal the fix depends on', () => {
    const d = repo({ importInChangedFile: true });
    const status = execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status).toContain('src/a.ts');
  });
});

describe('THE DEFECT: an import the story introduced must be declared', () => {
  it('the undeclared package is detected even though node_modules has it', () => {
    const { installed } = depCheck(repo({ importInChangedFile: true }));
    expect(
      installed,
      'the story commits an import that nothing declares — it does not build from a clean checkout',
    ).toContain(PKG);
  });

  it('an already-declared package is not reinstalled', () => {
    // Guards against the fix turning into "install everything the file imports".
    const { installed } = depCheck(repo({ importInChangedFile: true }));
    expect(installed).not.toContain(DECLARED_PKG);
  });
});

describe('brownfield lenience is preserved', () => {
  it('an installed-but-undeclared import in an UNTOUCHED file is left alone', () => {
    // The original reason for the node_modules skip: a brownfield repo carries undeclared
    // transitive deps, and rewriting its manifest for code no story touched is not our business.
    const { installed } = depCheck(repo({ importInUntouchedFile: true }));
    expect(
      installed,
      "the gate rewrote a brownfield manifest over an import that no story touched",
    ).not.toContain(PKG);
  });

  it('a repo with no changes at all installs nothing', () => {
    expect(depCheck(repo()).installed).toEqual([]);
  });

  it('no dependency-check config means the check is a no-op', () => {
    const d = repo({ importInChangedFile: true });
    rmSync(join(d, '.epam', 'dependency-check.json'));
    expect(depCheck(d).installed).toEqual([]);
  });
});

/**
 * INTERNAL SOURCE IS NOT A PACKAGE, EVEN WHEN IT DOES NOT RESOLVE TO A FILE.
 *
 * Live 2026-08-09: `[dependency-check] Installing missing import: components (from
 * 'components/RoutesAndDepartures/DeparturesTab/DepartureDetailsSection')`. That specifier is an
 * internal path alias — the codelines declare baseUrl "./src" — and `components` is not a
 * package that exists on any registry.
 *
 * _resolves_inside_repo() asks whether the specifier names a FILE: `<root>/<spec><ext>` or
 * `<root>/<spec>/index<ext>`. The live path is a DIRECTORY holding .tsx files and no index, so
 * both misses, and an internal directory was classified as a third-party package.
 *
 * This is the surviving tail of a defect that once cost a run its entire budget: three lanes
 * attempted 346, 553 and 506 installs of 'components', 'api' and 'interface'. The file-based
 * resolution fixed the common case and left the directory case behind.
 *
 * A directory under a module root settles the question by itself: whatever the import does at
 * runtime — and this one may well be broken — it is this repository's own code, and running a
 * package manager against its first path segment is never the right answer. Deliberately a
 * filesystem question, like the check it extends: no tsconfig, no baseUrl, no language.
 */
describe('an internal path alias is never installed as a package', () => {
  it('a specifier naming a directory with no index file is not installed', () => {
    const { installed } = depCheck(repo({ internalDirImport: true }));
    expect(
      installed,
      "the package manager is run against this repository's own source directory",
    ).not.toContain('widgets');
  });

  it('nothing at all is installed for it', () => {
    const { installed } = depCheck(repo({ internalDirImport: true }));
    expect(installed.filter((p) => p.startsWith('widgets'))).toEqual([]);
  });

  it('a real undeclared package alongside it is still caught', () => {
    // The paired positive: ignoring internal directories must not blunt the check.
    const { installed } = depCheck(repo({ internalDirImport: true, importInChangedFile: true }));
    expect(installed).toContain(PKG);
    expect(installed).not.toContain('widgets');
  });

  it('a specifier that matches no directory and no file is still treated as a package', () => {
    // The negative: the directory rule must not swallow genuinely missing dependencies.
    const d = repo();
    writeFileSync(join(d, 'src', 'a.ts'), 'import x from "definitely-not-here";\nexport const a = x;\n');
    expect(depCheck(d).installed).toContain('definitely-not-here');
  });
});
