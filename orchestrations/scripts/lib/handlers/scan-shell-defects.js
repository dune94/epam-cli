#!/usr/bin/env node
/**
 * EVERY SHELL FILE, READ BY A STATIC ANALYSER — NO TESTS REQUIRED.
 *
 * The orchestration engine is mostly bash, and most of it has no test behind it. Coverage says how
 * much of it a test has EXECUTED; this says how much of it is wrong on its face, across 100% of the
 * files, in about a second. The two answer different questions and the second needs nothing written
 * first, which is why it is the cheaper half of the same problem.
 *
 * It is not a style pass. The classes it reports are ones that have already cost this project runs:
 *
 *   SC2155  `export VAR="$(cmd)"` takes export's exit status, always 0, masking the command's.
 *           tier3-mock-run.sh carries a comment describing this exact defect, found by hand; the
 *           scanner finds every other instance of it.
 *   SC2015  `A && B || C` is not if-then-else — C also runs when A succeeds and B fails. This is
 *           the shape of `cmd || true` followed by a read of $?, which made a test assert on the
 *           status of `true`.
 *   SC2188  a redirection with no command. An orphaned `<<< "..."` fragment of exactly this shape
 *           made a 41-assertion suite unparseable, so it had never run at all, for months.
 *   SC2031  a variable modified in a subshell, where the change is lost on exit.
 *
 * WARNING AND ABOVE, DELIBERATELY. Info and style are dominated by SC1091 ("not following" a
 * sourced file, which is correct here — the libraries are resolved at runtime) and SC2016 (single
 * quotes in jq programs, which is intended). Gating on those would bury the classes above in noise
 * nobody reads, and a ratchet nobody reads is a ratchet nobody keeps.
 *
 * FAILS CLOSED. shellcheck absent, or unable to run, exits non-zero so the gate reports "scanner
 * did not run" rather than a clean sheet. A scanner reporting nothing because it never ran is the
 * exact shape of the defects it exists to catch.
 *
 * Usage: scan-shell-defects.js <repo-root>     one finding per line, exit 0
 */
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

// A reader that closes early (`| head`) must not turn into a crash report: the findings list is
// long, reading the first few is the normal way to use it, and an EPIPE stack trace on top of a
// gate failure buries the finding it was printed for.
process.stdout.on("error", (e) => { if (e && e.code === "EPIPE") process.exit(0); throw e; });

const ROOT = process.argv[2] || process.cwd();
const SCAN_DIR = path.join(ROOT, 'orchestrations/scripts');

function die(msg) {
  process.stderr.write(`scan-shell-defects: ${msg}\n`);
  process.exit(1);
}

if (spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status !== 0) {
  die('shellcheck is not installed or would not run — install it (apt: shellcheck) so this gate '
    + 'can read the shell. Reporting no findings because the scanner is missing is exactly the '
    + 'silence this check exists to end.');
}

// A missing scan directory is the vacuous case, not a tool failure: say so in the words the
// operator needs, rather than passing find's own error up and calling it a crash.
if (!require("node:fs").existsSync(SCAN_DIR)) {
  die(`no shell files found under ${SCAN_DIR} — the scan would pass vacuously`);
}

let files;
try {
  files = execFileSync('find', [SCAN_DIR, '-name', '*.sh',
    '-not', '-path', '*/.venv*', '-not', '-path', '*/node_modules/*'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n').filter(Boolean).sort();
} catch (e) {
  die(`could not enumerate shell files under ${SCAN_DIR}: ${(e && e.message) || e}`);
}
if (!files.length) die(`no shell files found under ${SCAN_DIR} — the scan would pass vacuously`);

// shellcheck exits 1 when it HAS findings; that is a successful run, not a failure. Only a missing
// binary or a crash (>1, or no parseable output) means it could not do its job.
// ONE FILE PER PROCESS. shellcheck's memory grows worse than linearly with what it is handed;
// one call over every script in the tree exceeded the host's memory cap and the whole preflight
// was killed (2026-09-16). Per file the largest costs ~2 GB (the orchestrator's loop) and the
// rest a few hundred MB; the findings are the same list either way.
const findings = [];
for (const f of files) {
  const r = spawnSync('shellcheck', ['-f', 'json', '-S', 'warning', f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`shellcheck could not run on ${f}: ${r.error.message}`);
  let part;
  try {
    part = JSON.parse(r.stdout || '[]');
  } catch {
    die(`shellcheck produced no parseable report for ${f} (exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`);
  }
  if (!Array.isArray(part)) die(`shellcheck report for ${f} was not a list of findings`);
  findings.push(...part);
}
if (!Array.isArray(findings)) die('shellcheck report was not a list of findings');

// A SPLIT PROGRAM IS JUDGED AS ONE PROGRAM. shellcheck reads one file at a time; a variable the
// entrypoint assigns and a module uses is "unused" in the one and "unassigned" in the other, and
// a `cd` in a module reads as unguarded although the module only ever runs under the entrypoint's
// `set -e`. tools/split-maps declares which modules belong to which entrypoint (the 2026-09-16
// split of the two mains), so those three verdicts are re-read across the program: a name
// assigned in one member and referenced in another is neither unused nor unassigned, and a `cd`
// in a module of an entrypoint that sets -e is guarded. Everything else stands as reported.
const program = (() => {
  const out = new Map(); // file (relative) -> [member files]
  const maps = path.join(ROOT, 'orchestrations/scripts/tools/split-maps');
  if (!require('node:fs').existsSync(maps)) return out;
  for (const f of require('node:fs').readdirSync(maps)) {
    if (!f.endsWith('.json') || f.endsWith('.golden.json') || f === 'ceilings.json') continue;
    const main = `orchestrations/scripts/${f.replace(/\.json$/, '')}`;
    let modules = [];
    try { modules = Object.keys(JSON.parse(require('node:fs').readFileSync(path.join(maps, f), 'utf8'))).filter((m) => m !== '.').map((m) => `orchestrations/scripts/lib/${m}.sh`); } catch { continue; }
    const members = [main, ...modules];
    for (const m of members) out.set(m, { main, members });
  }
  return out;
})();
const textOf = new Map();
const text = (rel) => { if (!textOf.has(rel)) { try { textOf.set(rel, require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8')); } catch { textOf.set(rel, ''); } } return textOf.get(rel); };
// EVERY WAY A SHELL READS A VARIABLE, NOT JUST $NAME AND ${NAME. `${#NAME[@]}` (an array's
// length) and `${NAME[@]}` (its elements) put `#` between the brace and the name; the first
// pattern here did not admit that, so CLAUDE_PERMISSIONS — read by lib/story-attempt.sh only as
// `${#CLAUDE_PERMISSIONS[@]}` — was reported unused in claude.sh and REMOVED (771993fc,
// 2026-09-16). From that release every writer on the claude set ran with no permission flags.
const usedElsewhere = (rel, name) => (program.get(rel) || { members: [] }).members
  .some((m) => m !== rel && new RegExp(`(\\$\\{?[#!]?${name}\\b|^\\s*(?:export\\s+|local\\s+|declare\\s+[-a-zA-Z]*\\s+)?${name}(=|\\+=))`, 'm').test(text(m)));
const kept = findings.filter((f) => {
  const rel = String(f.file || '').replace(`${ROOT}/`, '');
  const prog = program.get(rel);
  if (!prog) return true;
  const m = /\b([A-Za-z_][A-Za-z0-9_]*) (?:appears unused|is referenced but not assigned)/.exec(String(f.message || ''));
  if ((f.code === 2034 || f.code === 2154) && m && usedElsewhere(rel, m[1])) return false;
  if (f.code === 2164 && rel !== prog.main && /^set -[a-z]*e/m.test(text(prog.main))) return false;
  return true;
});

for (const f of kept) {
  const rel = String(f.file || '').replace(`${ROOT}/`, '');
  process.stdout.write(`${rel}:${f.line}:${f.column} SC${f.code} ${f.level} ${f.message}\n`);
}
