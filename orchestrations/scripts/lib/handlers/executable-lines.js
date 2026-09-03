/**
 * WHICH LINES OF A FILE COULD EXECUTE — DEFINED ONCE.
 *
 * Two things need this answer and they must agree exactly, or the coverage gate reports a fraction
 * whose numerator and denominator were counted by different rules:
 *
 *   stage-coverage.js       the DENOMINATOR: a file the suite never saw contributes all its lines
 *   shell-trace-to-lcov.js  the NUMERATOR:   which of a shell file's lines a bats/vitest run hit
 *
 * When those two definitions drift, a shell file can report more covered lines than it has, or a
 * stage's percentage moves because a comment was reformatted. Defining it in one place is the only
 * way the number means anything.
 *
 * A LINE THAT CANNOT BE TRACED MUST NOT BE COUNTED. bash never emits an xtrace record for a function
 * declaration — it traces the commands inside the function, not the line that names it — so counting
 * `foo() {` guarantees a permanent, unfixable miss in every shell file that defines a function.
 * Block delimiters (fi, done, esac, then, do) are the same: real syntax, never traced. Excluding
 * them is not leniency, it is the difference between a reachable target and one nobody can hit.
 */

/** True when this trimmed line is structure rather than an executable command. */
function isStructural(t) {
  if (/^(fi|done|esac|\}|\{|else|elif|then|do|;;)$/.test(t)) return true;
  // `foo() {`, `function foo {`, `foo ()` — declarations, never traced.
  if (/^(function\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*\(\)\s*\{?$/.test(t)) return true;
  if (/^function\s+[A-Za-z_][A-Za-z0-9_-]*\s*\{?$/.test(t)) return true;
  return false;
}

/**
 * The 1-based line numbers that could execute, as a Set.
 * Handles `#` (shell, python), `//` and block comments (js, ts).
 */
function executableLineNumbers(src) {
  const out = new Set();
  let inBlock = false;
  src.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith('*')) return;
    if (isStructural(t)) return;
    out.add(i + 1);
  });
  return out;
}

/** How many lines of this source could execute. */
function countExecutableLines(src) {
  return executableLineNumbers(src).size;
}

module.exports = { executableLineNumbers, countExecutableLines, isStructural };
