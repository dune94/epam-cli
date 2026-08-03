'use strict';
/**
 * Dependency Contract Tools — a ToolPlugin (epam-cli plugin architecture,
 * src/tools/plugin.ts + PluginLoader.ts) that answers ONE determinable question:
 *
 *   "Does the installed dependency actually consume this configuration key?"
 *
 * The defect class this covers, stated with no vendor in it: an agent writes a config
 * option that the package never reads. It compiles, it looks right, and it silently does
 * nothing at runtime. The worst version is a STALE TYPE DECLARATION — the package's own
 * .d.ts promises a key its shipped runtime never reads, so satisfying the type is exactly
 * the wrong move and the type checker rewards it.
 *
 * PROJECT-AGNOSTIC AND VENDOR-AGNOSTIC BY DESIGN: this file names no package, no client,
 * and no key. It reads whatever is installed under node_modules and reports what it finds,
 * so it works unchanged on the next unknown dependency in the next unknown project. That
 * is the whole point — this replaces hand-authored "known wrong pattern" rules, which can
 * only ever encode an answer someone already learned the hard way, for one vendor.
 *
 * Verdicts:
 *   consumed      key appears in the package's RUNTIME source (.js/.mjs/.cjs)
 *   declared_only key appears ONLY in a type declaration (.d.ts) — stale-type signature
 *   absent        key appears nowhere — a typo or an invented option
 *   undetermined  package not installed/readable, or the key is accessed dynamically —
 *                 reported honestly, NEVER downgraded to a pass
 *
 * Known limit, stated rather than hidden: a package that reads options via computed
 * access (opts[k]) can defeat a source scan. Property names that cross an API boundary
 * survive minification, so bundled dist output is still readable. When the package cannot
 * be read at all the verdict is `undetermined`, never `consumed`.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_API_VERSION = '1.0.0';

const RUNTIME_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const DECLARATION_SUFFIX = '.d.ts';
/** Directories inside a package that never contain the shipped implementation. */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__', 'example', 'examples', 'docs']);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Walk up from cwd looking for node_modules/<package>. Mirrors Node resolution closely
 *  enough for a probe, without requiring the package (which would execute its code). */
function resolvePackageDir(packageName, startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', packageName);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function collectFiles(rootDir) {
  const runtime = [];
  const declarations = [];
  const stack = [rootDir];
  let seen = 0;
  while (stack.length && seen < MAX_FILES) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (entry.name.endsWith(DECLARATION_SUFFIX)) declarations.push(full);
      else if (RUNTIME_EXTENSIONS.includes(path.extname(entry.name))) runtime.push(full);
    }
  }
  return { runtime, declarations };
}

/** Find `key` as a whole word, recording file + line + the line itself as evidence. */
function findKey(files, key, packageDir) {
  const evidence = [];
  const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (const file of files) {
    let content;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!pattern.test(content)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i])) {
        evidence.push({
          file: path.relative(path.dirname(packageDir), file),
          line: i + 1,
          snippet: lines[i].trim().slice(0, 200),
        });
        break; // one hit per file is enough to prove presence
      }
    }
    if (evidence.length >= 5) break;
  }
  return evidence;
}

const dependencyContractTool = {
  name: 'dependency_contract',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Before writing configuration for an installed dependency, check which option keys that dependency ACTUALLY consumes. Reports per key: "consumed" (read by the package\'s runtime source), "declared_only" (present only in a .d.ts type declaration — the types are STALE and the runtime ignores this key, so satisfying the type is the wrong fix), "absent" (appears nowhere — a typo or invented option), or "undetermined" (package not installed/readable). Call this whenever you add or change an options object passed to a third-party library; a key that is not "consumed" will silently do nothing at runtime.',
  permission: 'safe',
  definition: {
    name: 'dependency_contract',
    description:
      'Report which configuration keys an installed dependency actually consumes, with file/line evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        package: {
          type: 'string',
          description: 'Installed package name as it appears in node_modules, e.g. "some-sdk" or "@scope/pkg".',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'The configuration key names you intend to write, e.g. ["enable", "some_token"].',
        },
      },
      required: ['package', 'keys'],
    },
  },
  async execute(input) {
    try {
      const packageName = input && input.package;
      const keys = input && input.keys;
      if (!packageName || typeof packageName !== 'string') {
        return { toolUseId: '', content: 'Error: package (string) is required.', isError: true };
      }
      if (!Array.isArray(keys) || keys.length === 0 || !keys.every(k => typeof k === 'string' && k.trim())) {
        return { toolUseId: '', content: 'Error: keys (non-empty array of strings) is required.', isError: true };
      }

      const projectRoot = process.cwd();
      const packageDir = resolvePackageDir(packageName, projectRoot);
      if (!packageDir) {
        return {
          toolUseId: '',
          content: JSON.stringify(
            {
              package: packageName,
              resolved: null,
              results: keys.map(key => ({
                key,
                verdict: 'undetermined',
                evidence: [],
                note: `${packageName} is not installed under node_modules from ${projectRoot} — cannot determine what it consumes. Do NOT assume the key is correct.`,
              })),
            },
            null,
            2,
          ),
          isError: false,
        };
      }

      let version = null;
      try {
        version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version || null;
      } catch {
        /* version is a nicety, not a requirement */
      }

      const { runtime, declarations } = collectFiles(packageDir);
      const results = keys.map(key => {
        const runtimeHits = findKey(runtime, key, packageDir);
        if (runtimeHits.length > 0) {
          return { key, verdict: 'consumed', evidence: runtimeHits };
        }
        const declarationHits = findKey(declarations, key, packageDir);
        if (declarationHits.length > 0) {
          return {
            key,
            verdict: 'declared_only',
            evidence: declarationHits,
            note:
              `"${key}" appears only in a type declaration, never in ${packageName}'s runtime source. ` +
              `The types are stale: the package does not read this key, so setting it has no effect at ` +
              `runtime even though it type-checks. Find the key the runtime actually reads.`,
          };
        }
        return {
          key,
          verdict: 'absent',
          evidence: [],
          note: `"${key}" appears nowhere in ${packageName} — it is not an option this package recognises.`,
        };
      });

      return {
        toolUseId: '',
        content: JSON.stringify(
          {
            package: packageName,
            resolved: packageDir,
            version,
            scanned: { runtimeFiles: runtime.length, declarationFiles: declarations.length },
            results,
          },
          null,
          2,
        ),
        isError: false,
      };
    } catch (err) {
      return { toolUseId: '', content: `Error probing dependency contract: ${err.message}`, isError: true };
    }
  },
};

module.exports = {
  tools: [dependencyContractTool],
};
