/**
 * SHELL COVERAGE IS NOT UNMEASURABLE — bash will report on itself.
 *
 * 138 of this repo's 441 files are shell, 28,558 of its 76,792 code lines. The JS instrument cannot
 * see any of them, so every shell file counted as wholly uncovered and the larger stages could never
 * clear a threshold no matter how many tests were written. That is not "shell is untestable"; it is
 * a missing conversion step.
 *
 * HOW THE TRACE IS COLLECTED (see tools/shell-coverage.sh): BASH_ENV names a file that every
 * non-interactive bash sources at startup. That file points BASH_XTRACEFD at a private descriptor,
 * sets PS4 to carry ${BASH_SOURCE}:${LINENO}, and turns on xtrace. Every bash the test suites start —
 * bats cases, and the hundreds of spawnSync('bash', ...) calls the vitest suite makes — then
 * announces each line it executes, into its own file rather than stderr, so nothing under test sees
 * different output than it would normally.
 *
 * WHAT WAS TRIED AND DOES NOT WORK, so nobody pays for it twice:
 *   - `export SHELLOPTS=xtrace` — SHELLOPTS is readonly; the assignment fails SILENTLY and nothing
 *     is traced. It looks like it worked.
 *   - PATH-shimming `bash` — hangs on nested invocations in this sandbox.
 *   - Tracing to stderr — corrupts every test that asserts on stderr, changing which code runs.
 *
 * ATTRIBUTION IS IMPERFECT AND THAT IS ACCOUNTED FOR. bash attributes a command substitution or a
 * multi-line quoted string to its LAST physical line, and `done <<< "$var"` sometimes emits nothing.
 * So a hit on a line that is not executable by the shared definition is mapped to nothing rather
 * than invented, and a line proven to run by its side effect but absent here is a MEASUREMENT gap,
 * not a test gap. The output is lcov, so it merges with the JS instrument's own.
 */
const fs = require('fs');
const path = require('path');
const { executableLineNumbers } = require('./executable-lines');

const REPO = process.env.SHELL_COVERAGE_ROOT || path.resolve(__dirname, '..', '..', '..', '..');

/** Every `@@<file>:<line>@@` the trace recorded, as file -> Set(line). */
function parseTrace(traceFile) {
  const hits = new Map();
  let text;
  try { text = fs.readFileSync(traceFile, 'utf8'); } catch { return hits; }
  const re = /@@([^@\n]+):(\d+)@@/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const file = m[1];
    const line = Number(m[2]);
    if (!file || !Number.isFinite(line)) continue;
    if (!hits.has(file)) hits.set(file, new Set());
    hits.get(file).add(line);
  }
  return hits;
}

/** The shell files that count, discovered — never a list maintained beside the code. */
function shellFiles(roots, excludePattern) {
  const out = [];
  const skip = excludePattern ? new RegExp(excludePattern) : null;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (skip && skip.test(full)) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && full.endsWith('.sh')) out.push(full);
    }
  };
  for (const r of roots) walk(path.resolve(REPO, r));
  return out.sort();
}

/**
 * lcov for every in-scope shell file.
 *
 * EVERY shell file appears, including ones the trace never touched. A file omitted from lcov is a
 * file the gate counts as wholly uncovered anyway — but emitting it explicitly means the report
 * shows WHICH shell files nothing exercises, which is the list worth having.
 */
function toLcov(hits, files) {
  const out = [];
  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const executable = executableLineNumbers(src);
    if (executable.size === 0) continue;
    const hitLines = hits.get(file) || hits.get(path.resolve(file)) || new Set();
    const rel = path.relative(REPO, file);
    out.push(`SF:${rel}`);
    let covered = 0;
    for (const n of [...executable].sort((a, b) => a - b)) {
      // A trace hit on a NON-executable line is dropped rather than credited: bash's attribution is
      // approximate, and inventing a covered line the definition does not recognise would let the
      // numerator exceed what the denominator counts.
      const hit = hitLines.has(n) ? 1 : 0;
      if (hit) covered += 1;
      out.push(`DA:${n},${hit}`);
    }
    out.push(`LF:${executable.size}`, `LH:${covered}`, 'end_of_record');
  }
  return `${out.join('\n')}\n`;
}

function main() {
  const traceFile = process.argv[2];
  const outFile = process.argv[3];
  if (!traceFile || !outFile) {
    process.stderr.write('usage: shell-trace-to-lcov.js <trace-file> <out.lcov>\n');
    process.exit(2);
  }
  const cfgPath = process.env.STAGE_COVERAGE_CONFIG
    || path.join(REPO, 'orchestrations/config/stage-coverage.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* defaults below */ }
  const files = shellFiles(cfg.roots || ['orchestrations/scripts', 'src'], cfg.excludePattern);
  const hits = parseTrace(traceFile);
  const lcov = toLcov(hits, files);
  fs.writeFileSync(outFile, lcov);

  const touched = files.filter((f) => (hits.get(f) || new Set()).size > 0).length;
  process.stderr.write(`[shell-coverage] ${files.length} shell files in scope, ${touched} exercised `
    + `by the suites, ${files.length - touched} never executed at all\n`);
  if (files.length && touched === 0) {
    // A CONVERSION THAT PRODUCED NOTHING IS A BROKEN COLLECTOR, NOT A ZERO. Reporting 0% here would
    // look exactly like "the tests are bad" and send someone writing tests that already exist.
    process.stderr.write('[shell-coverage] the trace recorded NOTHING — the collector did not run, '
      + 'or BASH_ENV never reached the shells under test. This is not a coverage result.\n');
    process.exit(3);
  }
}

if (require.main === module) main();
module.exports = { parseTrace, toLcov, shellFiles };
