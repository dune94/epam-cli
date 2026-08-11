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
  const src = () => readFileSync(PLUGIN, 'utf8')
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
    const code = readFileSync(PLUGIN, 'utf8')
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
    const src = readFileSync(CLAUDE, 'utf8');
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
