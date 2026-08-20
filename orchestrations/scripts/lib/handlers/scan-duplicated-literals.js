#!/usr/bin/env node
/**
 * scan-duplicated-literals.js — code literals that restate a value the DATA LAYER already owns.
 *
 * The pipeline has a template layer (orchestrations/prompts/templates/*.json) and a config layer
 * (orchestrations/config/*.json). A string sitting in a script that is byte-identical to a value
 * one of those files already defines is a second place to maintain the same fact — and the copy
 * is the one that drifts. Ten confirmed defects on 2026-08-20 were of this shape.
 *
 * DELIBERATELY NARROW, because every coarse scan written this week inflated by 5-25x:
 *   - only values the data layer REALLY defines, read from the files, never a list kept here
 *   - only literals of MIN_LEN or more, so punctuation and single words cannot collide
 *   - the data files themselves are not scanned against themselves
 *   - CONTENT ONLY: the value must contain whitespace.
 *
 * That last rule is what took the first run of this scan from 272 to a real number. A template id
 * ("repro-test-writer"), a placeholder name ("__MANIFEST_FILE__") and an env var
 * ("LANGFUSE_BASE_URL") all appeared as "duplicated values" — but code MUST name the thing it
 * addresses, and 141 of the 272 were exactly that. Keys and identifiers do not contain spaces;
 * prose the data layer owns does. Naming a template is a reference. Restating its text is a copy.
 *
 * The number is a RATCHET, not a verdict on any one site. Pre-flight fails when it grows.
 *
 *   node scan-duplicated-literals.js [repoRoot]     → one "file:line\tvalue" per occurrence
 *
 * Exit 0 always: this reports, the caller decides. An exit code here would make the count itself
 * fatal, which is the opposite of a ratchet.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MIN_LEN = 12;

/**
 * Is this string CONTENT the data layer owns, rather than a key code must name to address it?
 *
 * ONE definition, used by both sides of the comparison. It was written twice — once over the data
 * layer, once over the code literals — and a mutation test proved that made it undetectable:
 * removing either copy alone changed nothing, because the other still filtered. Two places holding
 * one rule is how a rule half-dies without a single test going red.
 */
function isContent(s) {
  return s.length >= MIN_LEN && /\s/.test(s);
}

const DATA_DIRS = [
  'orchestrations/prompts/templates',
  'orchestrations/config',
];

const CODE_GLOBS = [
  ['orchestrations/scripts', /\.(sh|js|py)$/],
  ['orchestrations/scripts/lib', /\.(sh|js|py)$/],
  ['orchestrations/scripts/lib/handlers', /\.(js|py)$/],
  ['src', /\.ts$/],
  ['src/agent', /\.ts$/],
  ['src/tools', /\.ts$/],
];

/** Every string value the data layer defines, at any depth. */
function dataLayerValues(root) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (isContent(s)) out.add(s);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const d of DATA_DIRS) {
    const dir = path.join(root, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try { walk(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* unparseable is another check's job */ }
    }
  }
  return out;
}

/** Code files to scan, deduped — the glob list overlaps on purpose so nothing is missed. */
function codeFiles(root) {
  const seen = new Set();
  for (const [d, re] of CODE_GLOBS) {
    const dir = path.join(root, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!re.test(n)) continue;
      const p = path.join(dir, n);
      try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
      seen.add(p);
    }
  }
  return [...seen];
}

/** String literals on one line: '...', "...", `...`. Returns trimmed inner text. */
function literalsOn(line) {
  const out = [];
  for (const m of line.matchAll(/'([^'\\]{8,})'|"([^"\\]{8,})"|`([^`\\]{8,})`/g)) {
    const v = (m[1] ?? m[2] ?? m[3]).trim();
    if (isContent(v)) out.push(v);
  }
  return out;
}

function scan(root) {
  const values = dataLayerValues(root);
  const hits = [];
  if (values.size === 0) return { hits, dataValues: 0 };
  for (const f of codeFiles(root)) {
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    src.split('\n').forEach((line, i) => {
      if (/^\s*(#|\/\/|\*)/.test(line)) return;            // a comment quoting a value is not a copy
      for (const lit of literalsOn(line)) {
        if (values.has(lit)) hits.push({ file: path.relative(root, f), line: i + 1, value: lit });
      }
    });
  }
  return { hits, dataValues: values.size };
}

module.exports = { scan, dataLayerValues, literalsOn, isContent, MIN_LEN };

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  const { hits } = scan(root);
  for (const h of hits) console.log(`${h.file}:${h.line}\t${h.value}`);
}
