'use strict';
/**
 * WHICH CHANGED FILES DOES THIS REPOSITORY ROUTE TO A GIVEN COMMIT-TIME TOOL?
 *
 * The story-lint gate ran the repository's linter over EVERY changed file and reported that the
 * pre-commit hook would reject the commit. Live 2026-08-10 it failed a story on two files:
 *
 *     package.json       1:1  error  Expected an assignment or function call
 *     package-lock.json  1:1  error  Expected an assignment or function call
 *
 * — a linter parsing data files as source. The repository's own routing never sends them there:
 * one glob routes source to the linter, another routes data files to a formatter. The gate was
 * stricter than the hook it claimed to reproduce, and blocked work the writer had to do (adding a
 * dependency) over a check that would never have run.
 *
 * The old selection asked the linter "do you have a config for this path". Under a flat config the
 * answer is yes for ANY path. "A config exists" is not "the hook lints this".
 *
 * THE ROUTING IS A REPOSITORY FACT, so it is read from the repository. Nothing in this file names
 * an extension, a language, a framework, a tool or a filename. The tool is supplied by the caller
 * (from the binary it actually discovered), the globs come from the repo's own declaration, and
 * matching uses the repo's OWN matcher — so the semantics are identical to the hook's by
 * construction rather than by a reimplementation that drifts.
 *
 * Usage:  node lint-staged-scope.js <projectRoot> <toolBasename>   (changed paths on stdin)
 * Output: the subset of those paths the repo routes to that tool, one per line.
 * Exit:   0 = answered (possibly with an empty set)
 *         3 = UNKNOWN — no declaration, unreadable declaration, or no matcher available.
 *
 * UNKNOWN is a distinct exit code because "this repo declares no routing" and "no file matches"
 * are different findings, and collapsing them would silently disable the gate for every repository
 * that does not use this mechanism. The caller keeps its previous behaviour on UNKNOWN.
 */

const fs = require('node:fs');
const path = require('node:path');

const UNKNOWN = 3;

/**
 * The declaration, discovered the way the staging tool itself discovers it: a key in the package
 * manifest, or a dedicated rc/config file. Names come from the tool's documented lookup order, not
 * from any assumption about the project's language or layout.
 */
function loadDeclaration(projectRoot, toolName) {
  const manifest = path.join(projectRoot, 'package.json');
  if (fs.existsSync(manifest)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (pkg && pkg[toolName] && typeof pkg[toolName] === 'object') return pkg[toolName];
    } catch { /* fall through to the rc files */ }
  }
  // Both spellings. A hyphenated tool name conventionally loses its hyphen in the rc filename
  // while keeping it in the `<name>.config.*` form, and the manifest key keeps it. Deriving only
  // one spelling silently found no declaration and reported UNKNOWN for a repo that had one —
  // which is how the fix for an over-strict gate would have quietly disabled the gate instead.
  const compact = toolName.replace(/-/g, '');
  const bases = [...new Set([`.${toolName}rc`, `.${compact}rc`, `${toolName}.config`, `${compact}.config`])];
  const exts = ['', '.js', '.cjs', '.mjs', '.json', '.yaml', '.yml'];
  for (const b of bases) {
    for (const e of exts) {
      const p = path.join(projectRoot, b + e);
      if (!fs.existsSync(p)) continue;
      try {
        if (e === '.json' || e === '') {
          const raw = fs.readFileSync(p, 'utf8');
          try { return JSON.parse(raw); } catch { /* not JSON — try require below */ }
        }
        // eslint-disable-next-line import/no-dynamic-require, global-require
        const mod = require(p);
        if (mod && typeof mod === 'object') return mod.default && typeof mod.default === 'object' ? mod.default : mod;
      } catch { /* unreadable — keep looking, then report UNKNOWN */ }
    }
  }
  return null;
}

/**
 * Does this glob's declared action invoke the tool we are about to run?
 *
 * The action may be a string, an array of strings, or a function returning either — the shapes the
 * staging tool accepts. A function is CALLED with a representative file list, because that is the
 * only way to see the command it builds; it is the repository's own config being evaluated, which
 * the staging tool does at commit time anyway.
 */
function routesTo(action, tool, sampleFiles) {
  let value = action;
  if (typeof value === 'function') {
    try { value = value(sampleFiles); } catch { return false; }
  }
  const commands = Array.isArray(value) ? value : [value];
  return commands.some((c) => typeof c === 'string' && commandInvokes(c, tool));
}

/**
 * A command string invokes the tool when the tool appears as a COMMAND WORD, not merely as a
 * substring. Guards against a path or a flag value that happens to contain the name.
 */
function commandInvokes(command, tool) {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s;&|(])(\\S*[/\\\\])?${escaped}(\\s|$)`).test(command);
}

function main() {
  const [, , projectRoot, tool] = process.argv;
  if (!projectRoot || !tool) process.exit(UNKNOWN);

  // The staging tool's own name is derived from nothing here: the caller passes the tool it found,
  // and the declaration is looked up under the staging mechanism's name, supplied by the caller's
  // environment so this file names no product.
  const stagingName = process.env.EPAM_COMMIT_STAGING_TOOL || 'lint-staged';

  const decl = loadDeclaration(projectRoot, stagingName);
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) process.exit(UNKNOWN);

  // The repository's OWN matcher, so glob semantics (extended patterns, brace and option groups)
  // are identical to what the hook applies. Reimplementing them is how a gate's verdict drifts
  // from the hook's — which is the entire defect this file exists to fix.
  let matcher;
  try {
    matcher = require(require.resolve('micromatch', { paths: [projectRoot] }));
  } catch {
    process.exit(UNKNOWN);
  }

  const files = String(fs.readFileSync(0, 'utf8')).split('\n').map((s) => s.trim()).filter(Boolean);
  const globs = Object.keys(decl);
  const selected = new Set();

  for (const glob of globs) {
    const matched = matcher(files, glob, { dot: true });
    if (!matched.length) continue;
    if (routesTo(decl[glob], tool, matched)) matched.forEach((f) => selected.add(f));
  }

  // Input order preserved: the caller passes these straight to a command line, and a stable order
  // keeps its output diffable across attempts.
  for (const f of files) if (selected.has(f)) process.stdout.write(`${f}\n`);
  process.exit(0);
}

main();
