/**
 * LINE COVERAGE FOR SHELL, BUILT RATHER THAN INSTALLED.
 *
 * 28,530 of this engine's 46,079 code lines are bash — 62% — and nothing measured them. kcov,
 * bashcov and shellspec are all absent and cannot be installed here, so the question "what have we
 * never run" could not be asked of the larger half of the pipeline. That is how a branch shipped at
 * v1.5, was never once exercised by a test, and killed a live run.
 *
 * WHAT AN EARLIER ATTEMPT LEARNED, kept because the knowledge is dearer than the code.
 * orchestrations/scripts/tools/bash-coverage.js did this first on 2026-07-12, was wired to
 * nothing, and rotted for seven weeks until a dead-code scan found it. It ran but produced no
 * trace here, so it is gone; these are the observations it paid for:
 *
 *   - PATH-shimming `bash` across nested invocations HANGS in this sandboxed shell. Invoke the
 *     target directly.
 *   - bash's $LINENO attribution is not consistent by command shape. A command-substitution
 *     assignment and a multi-line quoted string attribute their single hit to the LAST physical
 *     line; a plain command with a multi-line argument list and a trailing redirect has been seen
 *     attributing to the FIRST.
 *   - `done <<< "$var"` sometimes produces no hit at all even when the loop body demonstrably ran.
 *   - So when a line a test PROVABLY exercises still reads uncovered — verified by the command's
 *     real side effect, not by the trace — treat it as a measurement gap, not a test gap, before
 *     writing a test to "cover" it.
 *
 * bash can answer it itself. With PS4 carrying ${BASH_SOURCE}:${LINENO} and xtrace sent to its own
 * descriptor, every executed line announces itself — the same mechanism bashcov uses. The trace fd
 * is separate from stderr, so a script's own diagnostics stay readable and nothing under test has
 * to change.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Lines that can execute: not blank, not a comment, not a bare block delimiter. */
function codeLines(src) {
  const out = new Set();
  src.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    if (/^(fi|done|esac|\}|\{|else|;;)$/.test(t)) return;
    // A function DECLARATION never appears in an xtrace: bash traces the commands inside it, not
    // the line that names it. Counting it guarantees a permanent, unfixable miss.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?$/.test(t)) return;
    if (/^(then|do)$/.test(t)) return;
    out.add(i + 1);
  });
  return out;
}

/**
 * Run a bash snippet with tracing on, and report which lines of which files executed.
 *
 * `script` is bash source. Anything it sources by absolute path is measured too, which is the
 * point: a test that sources lib/gate-verdicts.sh measures the REAL file, not a copy.
 */
function traceRun(script, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-cov-'));
  const traceFile = path.join(dir, 'trace');
  const runner = path.join(dir, 'run.sh');
  // PS4 must not contain anything that expands per-command beyond the two we want, or the trace
  // becomes unparseable on lines containing the delimiter.
  fs.writeFileSync(runner, [
    'exec 9>' + JSON.stringify(traceFile),
    "export BASH_XTRACEFD=9",
    "export PS4='@@COV@@${BASH_SOURCE}@@${LINENO}@@'",
    'set -x',
    script,
    'set +x',
    '',
  ].join('\n'));

  const r = spawnSync('bash', [runner], {
    encoding: 'utf8',
    timeout: opts.timeout || 120000,
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
  });

  const hits = new Map();
  let trace = '';
  try { trace = fs.readFileSync(traceFile, 'utf8'); } catch { /* nothing ran */ }
  for (const line of trace.split('\n')) {
    const m = /@@COV@@(.*?)@@(\d+)@@/.exec(line);
    if (!m) continue;
    const file = m[1];
    if (!file || file === runner) continue;
    if (!hits.has(file)) hits.set(file, new Set());
    hits.get(file).add(Number(m[2]));
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', hits };
}

/** Coverage of the named files, given the hits from one or more traceRun calls. */
function coverageOf(files, ...hitMaps) {
  const merged = new Map();
  for (const h of hitMaps) {
    for (const [f, lines] of h) {
      const key = path.resolve(f);
      if (!merged.has(key)) merged.set(key, new Set());
      for (const l of lines) merged.get(key).add(l);
    }
  }
  const report = {};
  for (const f of files) {
    const abs = path.resolve(f);
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = codeLines(src);
    const ran = merged.get(abs) || new Set();
    const covered = [...lines].filter((l) => ran.has(l));
    report[f] = {
      covered: covered.length,
      total: lines.size,
      pct: lines.size ? (covered.length / lines.size) * 100 : 100,
      uncovered: [...lines].filter((l) => !ran.has(l)).sort((a, b) => a - b),
    };
  }
  return report;
}

module.exports = { traceRun, coverageOf, codeLines };
