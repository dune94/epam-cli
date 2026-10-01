'use strict';
/**
 * RELATIVE PATHS ONLY — a fact about a codeline reaches an agent relative to where it works.
 *
 * Operator, 2026-10-01: "hard coded local paths are not generated into prompts or SI text. This is
 * not permitted. Relative paths only." The brownfield rehearsal found absolute paths in 106 of 115
 * prompts — mostly the codelines' own locations, written into context blocks by the engine.
 *
 * relativizeLocalPaths(text, bases): every absolute path in `text` that lies inside one of `bases`
 * is rewritten relative to the nearest (deepest) one — the base itself becomes ".". A path under no
 * base is left as it is (the rehearsal names those). Nothing else is touched: a URL, an API route or
 * a relative path is not a local absolute path.
 *
 * promptBases(env): the bases a call's prompt is relative to — its project root (PROJECT_ROOT, the
 * agent's working directory) and the codelines folder (JIRA_CODELINE_ROOT) — as the run declares
 * them, resolved; never named here.
 */
const path = require('path');

const ABSOLUTE = /(?<![\w.:/~-])\/[\w.-]+(?:\/[^\s"'`)\]},;]*)?/g;

function relativizeLocalPaths(text, bases) {
  if (typeof text !== 'string' || !text) return text;
  const roots = [...new Set((bases || []).filter(Boolean).map((b) => path.resolve(String(b))))]
    .sort((a, b) => b.length - a.length);
  if (!roots.length) return text;
  return text.replace(ABSOLUTE, (abs) => {
    const trail = /[.:]+$/.exec(abs); // sentence punctuation after a path is not part of it
    const p = trail ? abs.slice(0, -trail[0].length) : abs;
    for (const root of roots) {
      if (p === root) return '.' + (trail ? trail[0] : '');
      if (p.startsWith(root + '/')) return p.slice(root.length + 1) + (trail ? trail[0] : '');
    }
    return abs;
  });
}

function promptBases(env = process.env) {
  return [env.PROJECT_ROOT, env.JIRA_CODELINE_ROOT].filter(Boolean);
}

module.exports = { relativizeLocalPaths, promptBases };

// CLI: node relative-paths.js <file>... — rewrite each file in place, relative to the call's bases
// (the hub runs this on every prompt and SI it hands a runner).
if (require.main === module) {
  // eslint-disable-next-line global-require
  const fs = require('fs');
  const bases = promptBases();
  for (const f of process.argv.slice(2)) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const out = relativizeLocalPaths(text, bases);
      if (out !== text) fs.writeFileSync(f, out);
    } catch (e) { process.stderr.write(`[relative-paths] ${f}: ${e.message}\n`); process.exitCode = 1; }
  }
}
