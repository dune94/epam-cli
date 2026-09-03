#!/usr/bin/env node
/**
 * scan-provider-swap-unsafe.js — a provider-selection seam that does not derive from the active set.
 *
 * provider-sets.json's own $hotSwap says the requirement in one line: "one env var, no build, no
 * test run, no git operation, no file copied over another." That only holds if every seam that
 * picks a vendor actually asks EPAM_PROVIDER_SET. change-log/SEAM-CONSISTENCY-ANALYSIS.md
 * (2026-09-03) found 17 that do not: `${SOME_PROVIDER:-openrouter}` and friends, so a swap made
 * because a provider ran out of tokens leaves those 17 calling the exhausted one anyway.
 *
 * $spendProbeWhy in the same file records this EXACT class being found and fixed once, in ten
 * places across six launchers, and never generalised into a check — which is how it came back in
 * 17 other places with nothing to catch it. This scanner is that check.
 *
 * THE RULE: a line of the shape `${VAR:-LITERAL}` (as an assignment RHS, a case subject, or an
 * inline argument — all three are the same shape once you drop the surrounding syntax) is
 * swap-unsafe when:
 *   1. VAR's name contains PROVIDER (case-insensitive) — it is a provider-selection variable, and
 *   2. VAR's name does NOT end in _CLI or _CMD — those name an EXECUTABLE, not a vendor, and
 *      defaulting `EPAM_CLI` to `epam` or `CLAUDE_CMD` to `claude` is correct, not a defect, and
 *   3. LITERAL is one of the vendor tokens providers.json declares as `known` — a value that is
 *      not a known vendor at all (a flag, a path, anything else) is not this defect.
 *
 * THE VENDOR LIST IS NOT HARDCODED HERE. It is read from orchestrations/config/providers.json
 * `known`, the same declaration provider_to_cli() in claude.sh is meant to route — so a fifth
 * vendor added there is a fifth vendor this scanner looks for, with no edit here.
 *
 *   node scan-provider-swap-unsafe.js [repoRoot]     → one "file:line\tvar\tliteral" per site
 *
 * Exit 0 always — the caller ratchets on the count, same pattern as
 * scan-uncalibrated-guards.js / scan-duplicated-literals.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT_DIRS = ['orchestrations/scripts', 'orchestrations/scripts/lib'];

/** The vendor tokens this codebase actually knows, read from the single declared list. */
function knownVendors(root) {
  const p = path.join(root, 'orchestrations/config/providers.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(j.known) && j.known.length) return new Set(j.known);
  } catch { /* fall through */ }
  // NO GUESSED LIST. A tree with no providers.json cannot judge this — reporting nothing is
  // correct here, the same way testable-source.js reports nothing rather than assuming extensions.
  return new Set();
}

/**
 * `${VAR:-LITERAL}` wherever it appears — assignment, case subject, or inline argument are the
 * same textual shape once the surrounding syntax is stripped, so one pattern finds all three.
 * LITERAL may itself be another `${...}` fallback (nested), in which case only the innermost
 * literal is a real default and that is what this pattern captures.
 */
const FALLBACK = /\$\{([A-Za-z_][A-Za-z0-9_]*):-(?:\$\{[A-Za-z_][A-Za-z0-9_]*:-)?([A-Za-z][A-Za-z0-9_-]*)\}?\}/g;

function isBinaryName(varName) {
  return /_CLI$|_CMD$/.test(varName);
}

// ASSIGNMENT FORM: `PROVIDER="${5:-claude}"`. The var carrying the vendor default is not always
// the one named PROVIDER — here it is a POSITIONAL parameter, and the name that matters is the
// ASSIGNMENT TARGET on the left. Missed on the first pass against the real tree (found 16 of the
// 17 the analysis had verified by hand) until checked against update-monitor.sh:132. Kept as a
// second, independent pattern rather than folded into FALLBACK, because the two catch genuinely
// different shapes and merging them made the regex unreadable without buying anything.
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=.*:-([A-Za-z][A-Za-z0-9_-]*)\}?"?\s*$/;

function findings(root) {
  const vendors = knownVendors(root);
  const out = [];
  if (vendors.size === 0) return out;
  for (const d of SCRIPT_DIRS) {
    const dir = path.join(root, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.sh'))) {
      const p = path.join(dir, n);
      let lines = [];
      try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const t = line.trim();
        if (t.startsWith('#')) continue;                    // a comment naming the defect
        const seen = new Set();                             // de-dupe: both patterns can fire on one line

        FALLBACK.lastIndex = 0;
        let m;
        while ((m = FALLBACK.exec(line))) {
          const [, varName, literal] = m;
          if (!/PROVIDER/i.test(varName)) continue;
          if (isBinaryName(varName)) continue;
          if (!vendors.has(literal)) continue;
          const key = `${varName}:${literal}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ file: path.relative(root, p), line: i + 1, varName, literal });
        }

        const am = ASSIGNMENT.exec(line);
        if (am) {
          const [, target, literal] = am;
          if (/PROVIDER/i.test(target) && !isBinaryName(target) && vendors.has(literal)) {
            const key = `${target}:${literal}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ file: path.relative(root, p), line: i + 1, varName: target, literal });
            }
          }
        }
      }
    }
  }
  return out;
}

module.exports = { findings, knownVendors, isBinaryName };

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  for (const f of findings(root)) {
    console.log(`${f.file}:${f.line}\t${f.varName}\t${f.literal}`);
  }
}
