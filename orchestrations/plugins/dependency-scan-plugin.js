'use strict';
/**
 * IMPORT SCANNING AND MODULE RESOLUTION ARE LANGUAGE FACTS. THEY BELONG HERE.
 *
 * This replaces 371 lines of Python embedded in a shell heredoc at claude.sh:3760-4131, which
 * scanned source for imports, decided which specifiers were third-party, and AUTO-INSTALLED
 * whatever it called missing. It was not a plugin, and it hardcoded facts the project already
 * declares — in the same function that read the declaration:
 *
 *     ('node_modules', 'dist', '.git', '__pycache__', '.venv')   while vendorDirs was DECLARED
 *     'index' + ext                                              Node's resolution convention
 *     '**\/tsconfig*.json' / compilerOptions.paths                TypeScript config discovery
 *     join(project_root, 'node_modules', top_pkg)                the vendor dir again
 *
 * WHAT THAT COST, live 2026-08-11 (AMSD-2041/gotransit): `"components": "^0.1.0"` — a 2013
 * public npm package by an unrelated author — was installed into a transit operator's production
 * package.json and committed. `components` is that repository's OWN directory; bare specifiers
 * resolve to src/ via tsconfig baseUrl, and src/components/RoutesAndDepartures/... exists.
 * Dependency confusion, produced by the engine, not the writer.
 *
 * TWO INVARIANTS, both learned from that failure:
 *
 * 1. A MISSING DECLARATION IS UNKNOWN, NEVER A DEFAULT. The legacy scanner ran with its config
 *    absent: vendorDirs, scanFileExtensions and ignorePackages were empty, the hardcoded
 *    literals kept it working well enough to finish, and it produced a confident wrong answer.
 *    Had it been declaration-driven throughout it would have refused to run. Every required key
 *    is checked up front and named in the reason.
 *
 * 2. THIS NEVER INSTALLS. An unclassifiable specifier is a FINDING handed to the writer, which
 *    already holds dependency_available (declared in the project's plugins.json, provisioned to
 *    every codeline, reachable because the writer sets no tool allowlist) and can report
 *    "installed_undeclared" — exactly this case. The engine acting on its own regex verdict is
 *    what put a public package into a client manifest. There is no exec path in this file.
 *
 * AND THE RULE THAT MAKES 1 ENFORCEABLE: a key that is DECLARED must not ALSO exist as a literal
 * here. `vendorDirs` was declared and 'node_modules' written literally four times in one
 * function; that duplication is exactly what let the scan survive its missing declaration. There
 * is a test asserting no declared value appears as a literal in this file.
 */

const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join, sep } = require('node:path');

const PLUGIN_API_VERSION = '1.0.0';
const MANIFEST_REL = join('.epam', 'dependency-check.json');

/**
 * Keys without which a scan would be guessing.
 *
 * Listed as data so the reason names the missing key: "the scan cannot run" is not actionable,
 * "no importPattern declared" is.
 */
const REQUIRED_KEYS = [
  'manifestFile',
  'manifestKeys',
  'scanFileExtensions',
  'importPattern',
  'vendorDirs',
];

/** Read the project's scan declaration, or say precisely why it cannot be used. */
function readScanManifest(projectRoot, env = process.env) {
  // PROJECT CONFIG FIRST. For brownfield, the declaration lives inside epam-cli's own
  // orchestrations/projects/<name>/ and NEVER inside the client's repository — the engine does
  // not write to a client codeline. <projectRoot>/.epam/ is the fallback, legitimate only for a
  // greenfield project the pipeline scaffolds and therefore owns. Reversing these silently
  // prefers a stale copy checked into a client repo over the one the operator maintains.
  const candidates = [];
  if (env.EPAM_PROJECT_CONFIG_DIR) candidates.push(join(env.EPAM_PROJECT_CONFIG_DIR, 'dependency-check.json'));
  candidates.push(join(projectRoot, MANIFEST_REL));

  let cfg = null;
  let from = '';
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8'));
      from = path;
      break;
    } catch (e) {
      return { ok: false, reason: `dependency declaration is unreadable (${path}): ${e && e.message}` };
    }
  }
  if (!cfg) {
    return { ok: false, reason: `no dependency declaration found (looked at: ${candidates.join(', ')})` };
  }

  const missing = REQUIRED_KEYS.filter((k) => {
    const v = cfg[k];
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim() === '';
  });
  if (missing.length) {
    return { ok: false, reason: `dependency declaration is incomplete — missing: ${missing.join(', ')}`, from };
  }
  return { ok: true, cfg, from };
}

/**
 * A specifier the regex captured but which cannot be a module name.
 *
 * The live capture contained a NEWLINE — the pattern over-matched across lines — so it matched
 * no path on disk, fell through resolution, and its first path segment was handed to a package
 * manager. Whitespace in a specifier is evidence the capture is broken, not that a package by
 * that name exists.
 */
function isMalformedSpecifier(spec) {
  if (typeof spec !== 'string') return true;
  if (spec.trim() === '') return true;
  return /\s/.test(spec);
}

/**
 * Definitively not a module name — skipped SILENTLY, not reported.
 *
 * Distinct from malformed on purpose. A `${...}` interpolation or a `~`/`#` sigil is a normal
 * thing to find in source: the regex matched a fragment, nothing is wrong, and warning about it
 * on every run is the noise that stops anyone reading the line that matters. A capture
 * containing WHITESPACE is different — it means the pattern over-matched across a boundary,
 * which is a real problem worth surfacing, and is exactly how `components/RoutesAndDepartures\n…`
 * came to have its first path segment installed.
 */
function isNotAModuleName(spec) {
  if (typeof spec !== 'string') return true;
  if (spec.includes('${')) return true;
  return spec.startsWith('~') || spec.startsWith('#');
}

/** Directories the scan must not descend into or treat as module roots. */
function excludedDirs(cfg) {
  return new Set([
    ...(Array.isArray(cfg.vendorDirs) ? cfg.vendorDirs : []),
    ...(Array.isArray(cfg.buildArtifactDirs) ? cfg.buildArtifactDirs : []),
  ]);
}

/**
 * Where a bare specifier may resolve from.
 *
 * Declared when the project states them; otherwise discovered as the repo root plus its
 * top-level directories, minus the excluded ones. Discovery is a last resort and is reported,
 * because a repository whose module roots are not top-level directories would be mis-resolved
 * silently — which is the failure mode this whole file exists to remove.
 */
function moduleRoots(projectRoot, cfg) {
  if (Array.isArray(cfg.moduleRoots) && cfg.moduleRoots.length) {
    return { roots: cfg.moduleRoots.map((r) => join(projectRoot, r)), declared: true };
  }
  const skip = excludedDirs(cfg);
  const roots = [projectRoot];
  try {
    for (const entry of readdirSync(projectRoot).sort()) {
      if (entry.startsWith('.') || skip.has(entry)) continue;
      const full = join(projectRoot, entry);
      try { if (statSync(full).isDirectory()) roots.push(full); } catch { /* unreadable */ }
    }
  } catch { /* unreadable root */ }
  return { roots, declared: false };
}

/**
 * Does this specifier name something inside the repository?
 *
 * A DIRECTORY SETTLES IT. The legacy scanner checked '<root>/<spec><ext>' and
 * '<root>/<spec>/index<ext>'; a directory of components with no index file missed both, and an
 * internal path was classified as a third-party package. Whatever such an import does at
 * runtime — it may well be broken — it is this repository's own code, and a broken internal
 * import is a job for the import checks, never for a package manager.
 */
function resolvesInsideRepo(projectRoot, cfg, spec) {
  const { roots } = moduleRoots(projectRoot, cfg);
  const exts = Array.isArray(cfg.scanFileExtensions) ? cfg.scanFileExtensions : [];
  const indexNames = Array.isArray(cfg.indexFileNames) ? cfg.indexFileNames : [];
  const parts = spec.split('/');
  for (const root of roots) {
    const base = join(root, ...parts);
    try { if (statSync(base).isDirectory()) return true; } catch { /* not a directory */ }
    for (const ext of exts) {
      try { if (statSync(base + ext).isFile()) return true; } catch { /* next */ }
      for (const idx of indexNames) {
        try { if (statSync(join(base, idx + ext)).isFile()) return true; } catch { /* next */ }
      }
    }
  }
  return false;
}

/**
 * Alias prefixes the project's module config declares — local mappings, not packages.
 *
 * Searched RECURSIVELY. A monorepo declares aliases in sub-project configs, not only at the
 * root; live 2026-07-21 a codeline with 15+ workspace aliases stalled the check for 20+ minutes
 * per turn because each alias was treated as an uninstallable package.
 *
 * `moduleConfigGlob` is a FILENAME PATTERN the project declares (e.g. "tsconfig*.json"), and
 * `moduleAliasPath` is the dotted key path inside it holding the aliases. Neither is assumed.
 */
function declaredAliases(projectRoot, cfg) {
  const out = new Set();
  const globName = typeof cfg.moduleConfigGlob === 'string' ? cfg.moduleConfigGlob : '';
  const aliasPath = typeof cfg.moduleAliasPath === 'string' ? cfg.moduleAliasPath : '';
  if (!globName || !aliasPath) return out;

  const re = new RegExp(`^${globName.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const skip = excludedDirs(cfg);
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (!re.test(name)) continue;
      let parsed;
      try { parsed = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
      const node = aliasPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), parsed);
      if (node && typeof node === 'object') {
        for (const alias of Object.keys(node)) out.add(alias.replace(/\/\*+$/, ''));
      }
    }
  };
  walk(projectRoot, 0);
  return out;
}

/** What the project's manifest declares, across the keys the project says hold dependencies. */
function declaredDependencies(projectRoot, cfg) {
  const out = new Set();
  const file = join(projectRoot, String(cfg.manifestFile));
  if (!existsSync(file)) return out;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return out; }
  for (const key of (Array.isArray(cfg.manifestKeys) ? cfg.manifestKeys : [])) {
    const section = parsed[key];
    if (section && typeof section === 'object') for (const n of Object.keys(section)) out.add(n);
  }
  return out;
}

/**
 * Classify one specifier.
 *
 *   malformed        — the capture is not a module name (whitespace); never a package
 *   ignored          — the project declared it as not-a-dependency
 *   internal         — it resolves inside this repository, or matches a declared alias
 *   declared         — the manifest declares it
 *   unknown_external — none of the above. A FINDING for the writer, never an install.
 */
function classifySpecifier(projectRoot, spec, env = process.env) {
  if (isNotAModuleName(spec)) return 'not_a_module';
  if (isMalformedSpecifier(spec)) return 'malformed';
  const m = readScanManifest(projectRoot, env);
  if (!m.ok) return 'unknown';
  const { cfg } = m;

  const prefixed = (set) => [...set].some((d) => spec === d || spec.startsWith(`${d}/`));

  if (prefixed(new Set(Array.isArray(cfg.ignorePackages) ? cfg.ignorePackages : []))) return 'ignored';
  if (prefixed(declaredAliases(projectRoot, cfg))) return 'internal';
  if (resolvesInsideRepo(projectRoot, cfg, spec)) return 'internal';

  const declared = declaredDependencies(projectRoot, cfg);
  if (declared.has(spec)) return 'declared';
  if ([...declared].some((d) => spec.startsWith(`${d}/`))) return 'declared';

  // PRESENT IN A VENDOR DIRECTORY BUT NOT IN THE MANIFEST.
  //
  // A distinct verdict, not a pass. The build works locally and breaks for anyone installing
  // from the manifest — which is why dependency_available calls it unusable. But it is also the
  // steady state of many brownfield repos, so reporting every instance on every run is noise
  // that buries the one finding that matters. The caller decides, using what the story touched.
  const topSegment = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  for (const dir of (Array.isArray(cfg.vendorDirs) ? cfg.vendorDirs : [])) {
    try {
      if (statSync(join(projectRoot, dir, ...topSegment.split('/'))).isDirectory()) {
        return 'installed_undeclared';
      }
    } catch { /* not there */ }
  }

  return 'unknown_external';
}

/**
 * Every source file the project says to scan, skipping the directories it says to exclude —
 * and skipping NESTED SUB-PROJECTS.
 *
 * A directory carrying its own manifest declares its own dependencies. Scanning it against the
 * ROOT manifest reports every one of its imports as undeclared, which is both wrong and loud.
 * The sub-project is its own scan, not part of this one.
 */
function sourceFiles(projectRoot, cfg) {
  const exts = Array.isArray(cfg.scanFileExtensions) ? cfg.scanFileExtensions : [];
  const skip = excludedDirs(cfg);
  const manifestName = String(cfg.manifestFile || '');
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 16) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    // A nested manifest ends the walk for this branch — but never at the root, which IS the
    // project being scanned.
    if (depth > 0 && manifestName && entries.includes(manifestName)) return;
    for (const name of entries) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (exts.some((e) => name.endsWith(e))) out.push(full);
    }
  };
  walk(projectRoot, 0);
  return out;
}

/**
 * Scan the repository and REPORT. Nothing here acts on what it finds.
 *
 * Returns { status: 'unknown', reason } when the declaration cannot support a scan, so a caller
 * can distinguish "this project has no undeclared imports" from "nothing checked".
 */
function scanImports(projectRoot, env = process.env, opts = {}) {
  const m = readScanManifest(projectRoot, env);
  if (!m.ok) return { status: 'unknown', reason: m.reason };
  const { cfg } = m;

  let pattern;
  try { pattern = new RegExp(cfg.importPattern, 'g'); } catch (e) {
    return { status: 'unknown', reason: `importPattern is not a valid expression: ${e && e.message}` };
  }
  const stripPatterns = (Array.isArray(cfg.commentPatterns) ? cfg.commentPatterns : [])
    .map((p) => { try { return new RegExp(p, 'g'); } catch { return null; } })
    .filter(Boolean);

  const findings = [];
  const seen = new Map();
  for (const file of sourceFiles(projectRoot, cfg)) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    for (const re of stripPatterns) content = content.replace(re, '');
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match.slice(1).find((g) => g);
      if (!spec) continue;
      const verdict = classifySpecifier(projectRoot, spec, env);
      // An installed-but-undeclared package is reported only when THIS story touched the file
      // importing it. Otherwise it is pre-existing estate condition, and reporting it every run
      // buries the finding that matters. changedFiles absent = report nothing on that basis,
      // since "we cannot tell what changed" must not manufacture findings.
      const rel = file.slice(projectRoot.length + 1);
      const touched = Array.isArray(opts.changedFiles)
        && opts.changedFiles.some((c) => rel === c || rel.startsWith(`${c}/`));
      if (verdict === 'installed_undeclared' && !touched) continue;
      if (verdict === 'unknown_external' || verdict === 'malformed' || verdict === 'installed_undeclared') {
        const key = `${verdict}:${spec}`;
        if (!seen.has(key)) {
          seen.set(key, true);
          findings.push({ specifier: spec, verdict, file: file.slice(projectRoot.length + 1) });
        }
      }
    }
  }

  // PACKAGES THE PROJECT REQUIRES WITHOUT IMPORTING THEM.
  //
  // A type checker, a linter, a formatter — nothing in source imports them, so import scanning
  // can never find them, and their absence surfaces as a confusing failure much later. Opt-in
  // and generic: the project names them, so a Python estate can require "black"/"mypy" through
  // the identical key. There is no engine-side default list.
  const required = Array.isArray(cfg.requiredDevDependencies) ? cfg.requiredDevDependencies : [];
  if (required.length) {
    const declared = declaredDependencies(projectRoot, cfg);
    for (const pkg of required) {
      if (typeof pkg !== 'string' || !pkg.trim()) continue;
      if (declared.has(pkg)) continue;
      if (findings.some((f) => f.specifier === pkg)) continue;   // already flagged by the scan
      findings.push({ specifier: pkg, verdict: 'unknown_external', file: String(cfg.manifestFile) });
    }
  }

  const { declared: rootsDeclared } = moduleRoots(projectRoot, cfg);
  return { status: 'ok', findings, moduleRootsDeclared: rootsDeclared, declarationFrom: m.from };
}

const dependencyScanTool = {
  name: 'dependency_scan',
  permission: 'safe',
  definition: {
    name: 'dependency_scan',
    pluginApiVersion: PLUGIN_API_VERSION,
    description:
      'Report imports in this codeline that are neither declared in its manifest nor resolvable '
      + 'inside the repository. Classification comes from the project (.epam/dependency-check.json) '
      + 'so it works for any stack. This REPORTS ONLY — it never installs. A specifier reported as '
      + 'unknown_external needs a real decision: declare the package, or fix the import. One '
      + 'reported as malformed means the capture is broken, not that a package by that name exists. '
      + 'A project that has not declared how it scans reports UNKNOWN — never "no problems".',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'Absolute path to the repository. Defaults to PROJECT_ROOT.' },
      },
      required: [],
    },
  },
  async execute(input) {
    const projectRoot = (input && input.projectRoot) || process.env.PROJECT_ROOT || process.cwd();
    const r = scanImports(projectRoot);
    if (r.status === 'unknown') {
      return {
        isError: true,
        content: `dependency scan not possible for ${projectRoot}: ${r.reason}. `
          + `Declare it in ${MANIFEST_REL} — an undeclared project is reported as unknown, never as clean.`,
      };
    }
    if (!r.findings.length) {
      return { isError: false, content: 'every import is declared or resolves inside the repository' };
    }
    const lines = r.findings.map((f) => `  [${f.verdict}] ${f.specifier}  (${f.file})`);
    return { isError: false, content: `${r.findings.length} import(s) need a decision:\n${lines.join('\n')}` };
  },
};

module.exports = {
  pluginApiVersion: PLUGIN_API_VERSION,
  tools: [dependencyScanTool],
  readScanManifest,
  scanImports,
  classifySpecifier,
  resolvesInsideRepo,
  moduleRoots,
  isMalformedSpecifier,
  isNotAModuleName,
  REQUIRED_KEYS,
  MANIFEST_REL,
};
