#!/usr/bin/env node
/**
 * kb-replay.js — falsification harness for the self-heal KB redesign.
 *
 * Replays every historical healing episode through the new store and compiler and
 * reports what ACTUALLY comes out. Read-only: touches no pipeline state, spends
 * nothing, and is safe to run while a run is live.
 *
 * It exists to answer three questions that fixture-based tests cannot, because the
 * fixtures were written by the same person as the design:
 *
 *   1. Can a stable signature be derived from what we really log?
 *   2. Does synthesis actually COLLAPSE episodes into few rules, or does it rot?
 *   3. Would real failures COMPILE to gate/param/tool_scope — or has the
 *      `target=none` dead end simply been relocated behind better types?
 *
 * Question 3 is the falsification test for the whole design. A low compile rate
 * means the redesign does not help, and this script is meant to be able to say so.
 *
 * Usage: node orchestrations/scripts/kb-replay.js [--verbose]
 */
'use strict';

const fs = require('fs');
const path = require('path');

// OVERRIDABLE, so this can be pointed at a fixture. It reads healing episodes out of a logs tree and
// reports what the store and compiler really produce; with the tree hardcoded it could only ever be
// run against the live one, which means it could not be tested and its own answers could not be
// checked against a case whose outcome is known.
const ROOT = process.env.KB_REPLAY_ROOT || path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

// ── Load every historical episode ────────────────────────────────────────────
function loadEpisodes() {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'healing-events.jsonl') {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
        }
      }
    }
  };
  walk(path.join(ROOT, 'logs'));
  return out.filter(e => e.diagnosis);
}

/**
 * Derive a signature from a diagnosis.
 *
 * NOTE THE LIMITATION, it is the point of finding #1: only 4 of 118 real diagnoses
 * carry a compiler error code, because the diagnosis is LLM PROSE. A production
 * signature must come from the deterministic tool output (tsc/vitest), which the
 * episodic record does not currently capture. What follows is a keyword classifier
 * standing in for that, so the rest of the replay can proceed — it is NOT the
 * design's intended key.
 */
const CLASSES = [
  // Order matters: the first match wins. Derived by READING all 118 diagnoses,
  // then verified by re-running — not tuned until the number looked good.
  //
  // "pre-existing" is FIRST and is deliberately NOT a heal target: those episodes
  // are the tsc gate tripping on baseline errors in files the story never touched
  // (redis, stripe, otel, msw, jwt). That is a gate-configuration bug being logged
  // as an agent failure, and it accounts for ~16% of the corpus.
  ['pre-existing-noise',   /pre-existing|corrupted|unrelated (files|infrastructure)/i],
  ['test-env-precondition',/RAPIDAPI_KEY|beforeEach|beforeAll/i],
  ['vitest-autoexec-guard',/auto-execution|VITEST|import\(.\/cli|unhandled rejection/i],
  ['syntax-error',         /syntax|malformed|invalid TS|invalid character|brace|unterminated|unexpected/i],
  ['missing-dependency',   /missing .*(install|@types|package)|not installed|cannot find module|never created|non-existent module/i],
  ['missing-export',       /not exported|no exported member|missing from .*module|failed to export|exported \w+ .*missing/i],
  ['type-error',           /\bTS\d{4}\b|type assertion|strict mode|untyped|bare .object.|implicitly any/i],
  ['api-misuse',           /instead of|bare string|config object|mock lacks|signature/i],
];

function signatureOf(diagnosis) {
  const code = (String(diagnosis).match(/\bTS\d{4}\b/) || [])[0];
  if (code) return code;
  for (const [name, re] of CLASSES) if (re.test(diagnosis)) return name;
  return 'unclassified';
}

/**
 * Would this class compile to a real enforcement mechanism?
 *
 * Judged against machinery that ALREADY EXISTS in this repo — not mechanisms we
 * would have to invent to make the numbers look good. Each entry names the
 * existing thing it binds to.
 */
const COMPILE_MAP = {
  'syntax-error':          { kind: 'gate',  via: 'tsc --noEmit / parse validation (already runs)' },
  'missing-dependency':    { kind: 'gate',  via: 'dependency-check.json preflight (already runs)' },
  'type-error':            { kind: 'gate',  via: 'tsc --noEmit baseline-diff gate (already runs)' },
  'missing-export':        { kind: 'gate',  via: 'named-import-check in claude.sh (EXPORT_DECL_RE)' },
  'api-misuse':            { kind: 'gate',  via: 'CodeGraph dependency contracts (already injected)' },
  'vitest-autoexec-guard': { kind: 'gate',  via: 'a known tier3 invariant — cli.ts VITEST guard' },
  // 17 episodes, and one of them reads "...despite skill addendum instructions" —
  // a prose KB rule EXISTED and the agent walked past it. That single line is the
  // empirical case for pillar 3, taken from our own logs.
  'test-env-precondition': { kind: 'gate',  via: 'test precondition check — prose rule already failed here' },
  'pre-existing-noise':    { kind: null,    via: 'NOT a heal target: tsc gate tripping on baseline errors' },
  'unclassified':          { kind: null,    via: 'no mechanism identified' },
};
for (const c of Object.keys(COMPILE_MAP)) if (/^TS\d{4}$/.test(c)) COMPILE_MAP[c] = COMPILE_MAP['type-error'];

function main() {
  const episodes = loadEpisodes();
  const bySig = new Map();
  for (const e of episodes) {
    const sig = /^TS\d{4}$/.test(signatureOf(e.diagnosis)) ? 'type-error' : signatureOf(e.diagnosis);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(e);
  }

  console.log(`\nEPISODES IN: ${episodes.length}   DISTINCT SIGNATURES OUT: ${bySig.size}`);
  console.log(`collapse ratio: ${(episodes.length / bySig.size).toFixed(1)}x\n`);

  const rows = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length);
  let compiles = 0, noMechanism = 0;
  const byKind = {};

  console.log('SIGNATURE'.padEnd(22) + 'EPISODES'.padStart(9) + '  COMPILES TO   VIA');
  console.log('-'.repeat(100));
  for (const [sig, eps] of rows) {
    const m = COMPILE_MAP[sig] || COMPILE_MAP['unclassified'];
    if (m.kind) { compiles += eps.length; byKind[m.kind] = (byKind[m.kind] || 0) + eps.length; }
    else noMechanism += eps.length;
    console.log(sig.padEnd(22) + String(eps.length).padStart(9) + '  ' +
      String(m.kind || '— none —').padEnd(13) + ' ' + m.via);
  }

  console.log('\n' + '='.repeat(100));
  const pct = n => ((n / episodes.length) * 100).toFixed(1) + '%';
  console.log(`COMPILE RATE: ${compiles}/${episodes.length} (${pct(compiles)}) would bind to an EXISTING mechanism`);
  console.log(`NO MECHANISM: ${noMechanism}/${episodes.length} (${pct(noMechanism)})`);
  console.log(`by kind: ${JSON.stringify(byKind)}`);

  console.log('\nCOMPARISON — the system being replaced:');
  const applied = episodes.filter(e => Number(e.patches_applied) > 0).length;
  const none = episodes.filter(e => e.target === 'none').length;
  console.log(`  patches actually applied: ${applied}/${episodes.length} (${pct(applied)})`);
  console.log(`  routed to target=none:    ${none}/${episodes.length} (${pct(none)})`);

  if (VERBOSE) {
    console.log('\nUNCOMPILED SAMPLES (what the design still cannot enforce):');
    for (const [sig, eps] of rows) {
      if ((COMPILE_MAP[sig] || {}).kind) continue;
      eps.slice(0, 4).forEach(e => console.log(`  [${sig}] ${String(e.diagnosis).slice(0, 100)}`));
    }
  }
  console.log();
}

main();
