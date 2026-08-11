'use strict';
/**
 * Render a prompt section from a project-owned catalog.
 *
 * The engine composed these in shell heredocs, where they could not be changed per project,
 * could not be translated, and drifted — one rule ended up written twice, byte-identical, nine
 * lines apart in the same script, each copy then needing maintenance. Nothing named a stack, so
 * "no stack facts" was treated as satisfying the no-hardcoding rule; the rule is broader.
 *
 * A SEPARATE FILE ON PURPOSE. The obvious alternative — `node -e '...'` inline in claude.sh —
 * was tried three times on 2026-08-10 and broke the script every time: the JS carries braces and
 * quotes that have to survive a double-quoted shell string inside a command substitution. The
 * pattern that works is this one, already proven by lib/lint-staged-scope.js: a real file,
 * invoked as `node render-prompt-section.js <catalog> <key> [k=v ...]`.
 *
 * Contract:
 *   - Prints the rendered section to stdout, or NOTHING when the key is absent or empty.
 *   - Exit 0 either way. A missing section is a section the project chose not to define; it is
 *     not an error, and the caller appends nothing.
 *   - Placeholders are {name}, filled from k=v arguments. An unmatched placeholder is left
 *     VISIBLE — a section that silently loses a value reads as complete while being wrong.
 *
 * A section may be a string, or an object {header, rules[]} for a numbered block. Nothing here
 * knows what any section means.
 */

const fs = require('node:fs');

function fill(text, data) {
  return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : whole);
}

/**
 * A section may append rules SHARED with other sections, via `"shared": "<key>"`.
 *
 * Without this, a rule that applies to two arms of a branch has to be written into both, and
 * that is exactly what happened: two rules sat byte-identical in brownfieldNovel and
 * brownfieldExisting, and a comment claimed they had been de-duplicated when they had not. Each
 * copy then needs maintaining, and the copies drift — which is how one rule became two, written
 * nine lines apart, in the script this catalog replaced.
 *
 * Shared rules are appended AFTER the section's own, so a mode's specific instructions come
 * first and the universal ones close the list. Numbering runs continuously across both.
 */
function render(section, data, startIndex, catalog) {
  if (typeof section === 'string') return fill(section, data);
  if (!section || typeof section !== 'object') return '';
  const header = section.header ? fill(section.header, data) : '';
  const own = Array.isArray(section.rules) ? section.rules : [];

  let shared = [];
  if (section.shared && catalog) {
    const ref = String(section.shared).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), catalog);
    if (Array.isArray(ref)) shared = ref;
    else if (ref && Array.isArray(ref.rules)) shared = ref.rules;
  }

  const rules = [...own, ...shared];
  if (!header && !rules.length) return '';
  const n = Number.isFinite(startIndex) ? startIndex : 1;
  const numbered = rules.map((r, i) => `${n + i}. ${fill(r, data)}`);
  return [header, ...numbered].filter(Boolean).join('\n');
}

function main() {
  const [, , catalogPath, key, ...pairs] = process.argv;
  if (!catalogPath || !key) process.exit(0);

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch {
    // An unreadable catalog yields nothing. NOT a built-in default: a section nobody can read
    // should be visibly absent, not silently replaced by whatever was compiled in.
    process.exit(0);
  }

  const data = {};
  let startIndex;
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === '_startIndex') { startIndex = Number(v); continue; }
    data[k] = v;
  }

  // Dotted keys address nested sections, so one catalog can hold a whole prompt without the
  // caller needing a second file per section.
  const section = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), catalog);
  const out = render(section, data, startIndex, catalog);
  if (out) process.stdout.write(out);
  process.exit(0);
}

main();
