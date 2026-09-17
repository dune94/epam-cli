/**
 * IMPORT SCANNING AND MODULE RESOLUTION ARE LANGUAGE FACTS. THEY BELONG IN A PLUGIN.
 *
 * `run_dependency_check` is 371 lines of Python embedded in a shell heredoc at
 * claude.sh:3760-4131. It is not a plugin. It scans source for imports, decides which
 * specifiers are third-party, and AUTO-INSTALLS whatever it calls missing.
 *
 * It hardcodes facts the project already declares, in the same function that reads the
 * declaration:
 *
 *     3827  ('node_modules', 'dist', '.git', '__pycache__', '.venv')   ← vendorDirs is DECLARED
 *     3891  'index' + _ext                                            ← Node's resolution convention
 *     3900  glob '**\/tsconfig*.json'  /  compilerOptions.paths        ← TypeScript config discovery
 *     3932  os.path.join(project_root, 'node_modules', top_pkg)       ← the vendor dir again
 *
 * WHAT IT COST, live 2026-08-11 (AMSD-2041/gotransit). It installed
 * `"components": "^0.1.0"` — a 2013 public npm package by an unrelated author — into a transit
 * operator's production package.json. `components` is this repo's OWN directory: bare
 * specifiers resolve to src/ via tsconfig baseUrl, and `src/components/RoutesAndDepartures/...`
 * exists. Textbook dependency confusion, committed and installed.
 *
 * The captured specifier contained a NEWLINE (the log line ends mid-message), so it could never
 * match a path on disk, fell through resolution, and its first segment was handed to a package
 * manager. A malformed capture is not a package name.
 *
 * THE RULE THIS FILE ENFORCES, from the operator: a key that is DECLARED must not ALSO exist as
 * a literal. `vendorDirs` is declared and `'node_modules'` is written literally four times in
 * the same function — which is exactly why the scan kept working when the declaration was
 * absent, and produced a confident wrong answer instead of stopping.
 *
 * AND: THE ENGINE DOES NOT INSTALL. An unclassifiable specifier is a FINDING for the writer,
 * which already holds `dependency_available` (declared in the project's plugins.json,
 * provisioned into every codeline, and reachable because the writer sets no tool allowlist).
 *
 * Written BEFORE the plugin.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const PLUGIN = join(ROOT, 'orchestrations/plugins/dependency-scan-plugin.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A declaration complete enough to scan with. Every value is the PROJECT's, never the engine's. */
const FULL_DECL = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies', 'devDependencies'],
  scanFileExtensions: ['.ts', '.tsx'],
  importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
  vendorDirs: ['node_modules'],
  buildArtifactDirs: ['dist', '.git'],
  indexFileNames: ['index'],
  moduleConfigGlob: 'tsconfig.json',
  moduleAliasPath: 'compilerOptions.paths',
  ignorePackages: ['fs', 'path'],
};

function repo(decl: Record<string, unknown> | null, files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'depscan-')); dirs.push(d);
  if (decl) {
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/dependency-check.json'), JSON.stringify(decl, null, 2));
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(d, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return d;
}

function plugin() {
  delete require.cache[require.resolve(PLUGIN)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require(PLUGIN);
}

describe('the plugin exists and exposes the contract', () => {
  it('is a plugin, not engine code', () => {
    expect(existsSync(PLUGIN), 'orchestrations/plugins/dependency-scan-plugin.js does not exist').toBe(true);
  });

  it('exports scanImports, classifySpecifier and readScanManifest', () => {
    const p = plugin();
    for (const fn of ['scanImports', 'classifySpecifier', 'readScanManifest']) {
      expect(typeof p[fn], `${fn} must be exported`).toBe('function');
    }
  });
});

describe('AN ABSENT OR INCOMPLETE DECLARATION MEANS UNKNOWN — never a scan on defaults', () => {
  it('no declaration reports unknown', () => {
    const r = plugin().scanImports(repo(null));
    expect(r.status, 'a scan on empty defaults is what produced the wrong answer').toBe('unknown');
    expect(r.reason).toBeTruthy();
  });

  it('an unreadable declaration reports unknown', () => {
    const d = mkdtempSync(join(tmpdir(), 'depscan-')); dirs.push(d);
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam/dependency-check.json'), '{ not json');
    expect(plugin().scanImports(d).status).toBe('unknown');
  });

  for (const key of ['importPattern', 'scanFileExtensions', 'vendorDirs', 'manifestFile']) {
    it(`a declaration missing '${key}' reports unknown and names the key`, () => {
      const partial: Record<string, unknown> = { ...FULL_DECL };
      delete partial[key];
      const r = plugin().scanImports(repo(partial));
      expect(r.status, `scanning without ${key} would guess`).toBe('unknown');
      expect(String(r.reason)).toContain(key);
    });
  }
});

describe('CLASSIFICATION uses the declaration, and a repo directory is not a package', () => {
  const withSrc = () => repo(FULL_DECL, {
    'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    'src/components/RoutesAndDepartures/DeparturesTab/index.ts': 'export const x = 1;',
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
  });

  it('a specifier resolving to a repo directory is INTERNAL, never a package', () => {
    // The live failure: `components/...` is src/components/..., and its first segment was
    // handed to a package manager.
    expect(
      plugin().classifySpecifier(withSrc(), 'components/RoutesAndDepartures'),
      'this is the repository\'s own code — running a package manager on its first path segment is never right',
    ).toBe('internal');
  });

  it('a deeper internal path is INTERNAL too', () => {
    expect(plugin().classifySpecifier(withSrc(), 'components/RoutesAndDepartures/DeparturesTab')).toBe('internal');
  });

  it('a declared dependency is DECLARED', () => {
    expect(plugin().classifySpecifier(withSrc(), 'react')).toBe('declared');
  });

  it('a declared-ignore entry is IGNORED', () => {
    expect(plugin().classifySpecifier(withSrc(), 'fs')).toBe('ignored');
  });

  it('a genuinely unknown external specifier is reported as such', () => {
    expect(plugin().classifySpecifier(withSrc(), 'left-pad')).toBe('unknown_external');
  });

  it('a MALFORMED capture is never treated as a package name', () => {
    // The live capture contained a newline, so it matched no path and its first segment was
    // installed. Whitespace in a specifier means the regex over-matched, not that a package
    // by that name exists.
    for (const bad of ['components/RoutesAndDepartures\nsomething', 'a b', ' ', 'x\ty']) {
      expect(
        plugin().classifySpecifier(withSrc(), bad),
        `'${JSON.stringify(bad)}' is a broken capture, not a package`,
      ).toBe('malformed');
    }
  });
});

describe('THE PLUGIN NEVER INSTALLS', () => {
  const src = () => engineSource(PLUGIN)
    .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

  it('it cannot execute a process at all', () => {
    // Precise, not crude: an earlier version banned 'exec(' and failed on `pattern.exec(content)`,
    // a regex call. The load-bearing assertion is that child_process is never imported — without
    // it no install is reachable, whatever the rest of the file says.
    expect(
      src(),
      'the engine installing on its own verdict is what put a public package into a client ' +
      'manifest. An unclassifiable specifier is a FINDING for the writer, not an action.',
    ).not.toMatch(/require\(\s*['"](node:)?child_process['"]\s*\)/);

    for (const banned of ['execSync', 'spawnSync', 'execFileSync', 'execFile(', 'spawn(']) {
      expect(src(), `${banned} must not appear`).not.toContain(banned);
    }
  });

  it('scanImports reports findings rather than acting on them', () => {
    const r = plugin().scanImports(repo(FULL_DECL, {
      'package.json': JSON.stringify({ dependencies: {} }),
      'src/a.ts': "import x from 'left-pad';\nexport const y = x;",
      'tsconfig.json': '{}',
    }));
    expect(r.status).toBe('ok');
    expect(Array.isArray(r.findings), 'findings are the output — not an install').toBe(true);
  });
});

describe('DECLARED AND LITERAL MUST NOT COEXIST', () => {
  /**
   * The operator's rule, made mechanical. `vendorDirs` is declared AND 'node_modules' appears
   * as a literal four times in the legacy function — which is precisely why the scan kept
   * working with its declaration missing, and answered confidently and wrongly.
   */
  it('no declared value appears as a literal in the plugin', () => {
    const code = engineSource(PLUGIN)
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

    const declaredValues: string[] = [];
    for (const v of Object.values(FULL_DECL)) {
      if (typeof v === 'string') declaredValues.push(v);
      else if (Array.isArray(v)) declaredValues.push(...v.filter((x) => typeof x === 'string'));
    }
    expect(declaredValues.length, 'nothing to check — this test would pass vacuously').toBeGreaterThan(8);

    const offenders = declaredValues.filter((v) => v.length > 2 && code.includes(`'${v}'`) || code.includes(`"${v}"`));
    expect(
      offenders,
      'a value the project declares must not also be written into the plugin — that is the ' +
      'duplication that let the legacy scanner keep running without its declaration',
    ).toEqual([]);
  });
});

/**
 * WIRED IN — the legacy block must be GONE, not bypassed.
 *
 * claude.sh:3760-4131 held 371 lines of embedded Python that scanned, classified and installed.
 * Leaving it in place while calling the plugin elsewhere would mean two scanners with different
 * answers, and the hardcoded one still installing.
 */
describe('THE ENGINE ROUTES THROUGH THE PLUGIN AND NO LONGER SCANS', () => {
  const CLAUDE = join(ROOT, 'orchestrations/scripts/claude.sh');
  const fn = (() => {
    const src = engineSource(CLAUDE);
    const start = src.indexOf('run_dependency_check() {');
    expect(start, 'run_dependency_check moved — this test is anchored on it').toBeGreaterThan(0);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end)
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  })();

  it('the function is non-empty, so these assertions are not vacuous', () => {
    expect(fn.length).toBeGreaterThan(100);
  });

  it('the embedded Python scanner is gone', () => {
    expect(fn, '371 lines of embedded python3 must not survive the conversion').not.toContain('python3');
    expect(fn).not.toContain('PYEOF');
  });

  it('it calls the plugin', () => {
    expect(fn).toContain('dependency-scan-plugin.js');
  });

  for (const banned of ['node_modules', 'tsconfig', 'package.json', "'index'", 'npm install']) {
    it(`no longer names '${banned}'`, () => {
      expect(
        fn,
        `'${banned}' is a project fact — it belongs in the declaration, not the engine`,
      ).not.toContain(banned);
    });
  }

  it('installing is conditional on the project DECLARING autoInstall', () => {
    // Default must be no install: the engine acting on its own verdict is what put a public
    // package into a client manifest.
    expect(fn).toContain('autoInstall');
  });
});

// THE RUNTIME'S OWN MODULES, ASKED OF THE RUNTIME.
//
// regintel 20260916T200108Z, 2026-09-17: `from __future__ import annotations` was reported as an
// undeclared import and failed the story through the ladder — the scan knew declared, internal,
// vendored and ignored, never built-in. An ecosystem may declare builtinModulesCommand; the
// runtime lists its standard library; the plug-in spells no name.
describe('a built-in module of the runtime is BUILTIN, never a finding', () => {
  const python = {
    manifestFile: 'requirements.txt', scanFileExtensions: ['.py'],
    importPattern: '^\\s*(?:from\\s+([A-Za-z_][\\w]*)|import\\s+([A-Za-z_][\\w]*))',
    vendorDirs: ['.venv'], buildArtifactDirs: ['.git'], indexFileNames: ['__init__'],
    // As codeline-manifests.js derives it from the ecosystem's builtinModulesCommand: a LIST.
    builtinModules: ['__future__', 'os', 'json', 'sys'],
  };
  it("run 200108Z's shape: __future__ (and os, json) are builtin under the Python declaration", () => {
    const d = repo(python, { 'requirements.txt': 'fastapi\n', 'regintel/__init__.py': '' });
    const p = plugin();
    expect(p.classifySpecifier(d, '__future__')).toBe('builtin');
    expect(p.classifySpecifier(d, 'os')).toBe('builtin');
    expect(p.classifySpecifier(d, 'json')).toBe('builtin');
  });
  it('a third-party name is still unknown_external under the same declaration — the runtime does not claim it', () => {
    const d = repo(python, { 'requirements.txt': 'fastapi\n' });
    expect(plugin().classifySpecifier(d, 'httpx')).toBe('unknown_external');
    expect(plugin().classifySpecifier(d, 'fastapi')).toBe('declared');
  });
  it('a declaration without builtinModules classifies exactly as before', () => {
    const d = repo({ ...python, builtinModules: undefined }, { 'requirements.txt': 'fastapi\n' });
    expect(plugin().classifySpecifier(d, '__future__')).toBe('unknown_external');
  });
  it('the Python ecosystems declare it and the built manifest carries it; the Node ecosystem keeps its own list', () => {
    const eco = (n: string) => require(join(ROOT, 'orchestrations/ecosystems', n));
    expect(eco('requirements-txt.js').codelineManifests.dependencyCheck.builtinModulesCommand).toMatch(/stdlib_module_names/);
    expect(eco('pyproject-toml.js').codelineManifests.dependencyCheck.builtinModulesCommand).toMatch(/stdlib_module_names/);
    expect(eco('package-json.js').codelineManifests.dependencyCheck.builtinModulesCommand).toBeUndefined();
    const { build } = require(join(ROOT, 'orchestrations/scripts/lib/handlers/codeline-manifests.js'));
    const d = repo(null, { 'requirements.txt': 'fastapi\n' });
    const built = build(d)['dependency-check.json'];
    expect(built.builtinModulesCommand).toMatch(/stdlib_module_names/);
    // The command was RUN by the manifest builder and its answer carried as data.
    expect(built.builtinModules).toContain('__future__');
    expect(built.builtinModules).toContain('os');
  });
});

