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
const r = spawnSync('shellcheck', ['-f', 'json', '-S', 'warning', ...files],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (r.error) die(`shellcheck could not run: ${r.error.message}`);
let findings;
try {
  findings = JSON.parse(r.stdout || '[]');
} catch {
  die(`shellcheck produced no parseable report (exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`);
}
if (!Array.isArray(findings)) die('shellcheck report was not a list of findings');

for (const f of findings) {
  const rel = String(f.file || '').replace(`${ROOT}/`, '');
  process.stdout.write(`${rel}:${f.line}:${f.column} SC${f.code} ${f.level} ${f.message}\n`);
}
