#!/usr/bin/env node
// Real line-coverage measurement for bash scripts via `bash -x` + BASH_XTRACEFD.
//
// Works by direct absolute-path invocation of a small wrapper script (never
// through a PATH-intercepted `bash` shim) — transparent PATH-shimming across
// nested bash invocations was tried and reliably hung in this environment's
// sandboxed shell; direct invocation of a single target script/function does
// not have that problem and is what this tool does.
//
// Usage (CLI):    node bash-coverage.js <script.sh> [args...]
// Usage (module): const { runWithCoverage, reportCoverage } = require('./bash-coverage');
//
// KNOWN LIMITATION: bash's own $LINENO attribution for a multi-line logical
// statement is not fully consistent by command shape. Command-substitution
// assignments (`var=$(cmd \` ... `arg)`) and multi-line quoted strings both
// reliably attribute their one trace hit to the LAST physical line (handled
// below). But a plain external command with a multi-line argument list and a
// trailing redirect (e.g. `jq -n --arg x "$y" \` ... `'filter' \` ...
// `> file`) has been observed attributing its hit to the FIRST physical line
// instead -- and a `done <<< "$var"` loop-closer with a redirect sometimes
// gets no hit at all even when the loop body demonstrably ran. These are rare
// shapes; when a line an existing test provably exercises (verified by
// checking the command's real side effect, not just the trace) still shows
// "uncovered", treat it as a tool measurement gap, not a test gap, before
// writing a new test to "cover" it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REAL_BASH = '/usr/bin/bash';

const NON_EXECUTABLE_LINE = /^(fi|done|esac|\{|\}|then|else|elif|do|\)+;?|\)\s*;;)$/;
// A `name() {` function-definition line is never independently traced by
// bash -x (confirmed by direct trace inspection) -- the same structural
// class as the `fi`/`done`/`}` block-closer lines above.
const FUNCTION_DEF_LINE = /^\w+\(\)\s*\{$/;
const HEREDOC_START = /<<-?\s*['"]?(\w+)['"]?\s*$/;

// Lines inside a `<<'MARKER' ... MARKER` heredoc body are literal data handed
// to whatever command opened it (python3, cat, etc.) -- bash never executes
// or traces them as bash statements, so counting them as "coverable bash
// lines" would inflate the denominator and understate real coverage.
function findHeredocBodyLines(lines) {
  const excluded = new Set();
  let i = 0;
  while (i < lines.length) {
    const m = HEREDOC_START.exec(lines[i]);
    if (m) {
      // The opening line itself is also excluded: bash's own $LINENO tracking
      // for a compound command with a heredoc redirect does not reliably
      // attribute an xtrace hit to that line (confirmed by direct trace
      // inspection) -- a bash limitation, not evidence the command never ran.
      excluded.add(i + 1);
      const marker = m[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== marker) {
        excluded.add(j + 1);
        j++;
      }
      // The terminator line itself (e.g. `PYEOF`) is a heredoc delimiter,
      // not independently-traceable bash code.
      if (j < lines.length) excluded.add(j + 1);
      i = j + 1;
      continue;
    }
    i++;
  }
  return excluded;
}

// A line ending in an unescaped `\` continues onto the next physical line as
// part of the SAME logical bash statement. `bash -x` only ever emits one
// xtrace hit for such a statement -- and (confirmed by direct trace
// inspection) it attributes that hit to the LAST physical line of the chain,
// not the first (e.g. a `var=$(cmd \` ... `arg)` spanning 3 lines traces at
// the closing-paren line). So every line in the chain except the last must
// be excluded from the coverable set, leaving the last line as the
// statement's sole representative.
function findContinuationLines(lines) {
  const excluded = new Set();
  let i = 0;
  while (i < lines.length) {
    if (/\\$/.test(lines[i])) {
      let j = i;
      while (j < lines.length && /\\$/.test(lines[j])) {
        excluded.add(j + 1); // not the final line -- exclude
        j++;
      }
      i = j + 1; // skip past the final (non-excluded) line of the chain
    } else {
      i++;
    }
  }
  return excluded;
}

// A quoted string (single OR double) that spans multiple physical lines --
// e.g. a multi-line jq filter in '...', or a multi-line message in "..." --
// is still ONE logical statement. bash traces it once, at its opening line,
// same as a heredoc or backslash-continuation, and (confirmed by direct
// trace inspection) attributes that one hit to the LAST physical line of the
// span, not the first. Single-quoted strings ignore `"` entirely and vice
// versa, so both quote types must be tracked together, char-by-char, exactly
// like bash's own lexer -- two independent regex passes (one per quote type)
// would each misparse lines containing the other quote character.
function findQuoteContinuationLines(lines, skipLines) {
  const excluded = new Set();
  let openQuote = null; // "'" or '"' or null
  let spanStart = null; // 1-indexed line where the open quote started
  for (let i = 0; i < lines.length; i++) {
    if (skipLines.has(i + 1)) continue; // heredoc body: not real bash quoting context
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (openQuote === null) {
        if ((ch === '"' || ch === "'") && line[c - 1] !== '\\') {
          openQuote = ch;
          spanStart = i + 1;
        }
      } else if (ch === openQuote && (openQuote === "'" || line[c - 1] !== '\\')) {
        // Single quotes have no escape mechanism in bash; only double quotes
        // respect a preceding backslash.
        if (spanStart !== i + 1) {
          for (let ln = spanStart; ln < i + 1; ln++) excluded.add(ln);
        }
        openQuote = null;
        spanStart = null;
      }
    }
  }
  return excluded;
}

function computeExecutableLines(source) {
  const lines = source.split('\n');
  const heredocBody = findHeredocBodyLines(lines);
  const continuation = findContinuationLines(lines);
  const quoteContinuation = findQuoteContinuationLines(lines, heredocBody);
  const set = new Set();
  lines.forEach((line, i) => {
    const lineno = i + 1;
    if (heredocBody.has(lineno) || continuation.has(lineno) || quoteContinuation.has(lineno)) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#')) return;
    if (NON_EXECUTABLE_LINE.test(trimmed)) return;
    if (FUNCTION_DEF_LINE.test(trimmed)) return;
    set.add(lineno);
  });
  return set;
}

// Runs `bash <scriptPath> [args...]` under xtrace, returning the set of
// "file:line" hits actually executed, plus the normal process result.
function runWithCoverage({ scriptPath, args = [], cwd, env = {} }) {
  const tmp = os.tmpdir();
  const traceLog = path.join(tmp, `bashcov-trace-${crypto.randomBytes(6).toString('hex')}.log`);
  const wrapperPath = path.join(tmp, `bashcov-wrapper-${crypto.randomBytes(6).toString('hex')}.sh`);

  fs.writeFileSync(
    wrapperPath,
    [
      '#!/usr/bin/env bash',
      `exec 91>>"${traceLog}"`,
      `BASH_XTRACEFD=91 PS4='+COVTRACE \${BASH_SOURCE}:\${LINENO}: ' exec "${REAL_BASH}" -x "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  );

  const result = spawnSync(REAL_BASH, [wrapperPath, scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

  const hits = new Set();
  if (fs.existsSync(traceLog)) {
    const content = fs.readFileSync(traceLog, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\+COVTRACE (.+):(\d+): /);
      if (m) hits.add(`${m[1]}:${m[2]}`);
    }
    fs.unlinkSync(traceLog);
  }
  fs.unlinkSync(wrapperPath);

  return { hits, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Same as runWithCoverage, but runs a snippet of bash source directly
// (e.g. an extracted function body + a call to it) instead of a file on disk.
// Useful for the extractFunctionBody()-style tests already used in this repo.
//
// `measureFragment`, if given, must be a substring of `source` (typically the
// extracted function body). Hit line numbers get rebased to be relative to
// that fragment's own first line -- NOT the assembled script's line number --
// so they line up with computeExecutableLines(measureFragment). Without this,
// hits stay numbered relative to the full assembled script (headers, stub
// functions, etc. all shift the numbering), which silently misaligns them
// against a report computed over the fragment alone.
function runSourceWithCoverage({ source, sourcePath, measureFragment, args = [], cwd, env = {} }) {
  const tmp = os.tmpdir();
  const scriptPath = path.join(tmp, `bashcov-src-${crypto.randomBytes(6).toString('hex')}.sh`);
  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
  const result = runWithCoverage({ scriptPath, args, cwd, env });
  fs.unlinkSync(scriptPath);

  let lineOffset = 0;
  if (measureFragment) {
    const idx = source.indexOf(measureFragment);
    if (idx === -1) {
      throw new Error('measureFragment is not a substring of source — cannot compute line offset');
    }
    lineOffset = source.slice(0, idx).split('\n').length - 1;
  }

  if (sourcePath || measureFragment) {
    const rekeyed = new Set();
    for (const hit of result.hits) {
      const idx = hit.lastIndexOf(':');
      const file = sourcePath || hit.slice(0, idx);
      const lineno = Number(hit.slice(idx + 1)) - lineOffset;
      if (lineno >= 1) rekeyed.add(`${file}:${lineno}`);
    }
    result.hits = rekeyed;
  }
  return result;
}

function reportCoverage(scriptPathOrSource, hitsSet, opts = {}) {
  const source = opts.isSource ? scriptPathOrSource : fs.readFileSync(scriptPathOrSource, 'utf8');
  const key = opts.logicalPath || (opts.isSource ? null : path.resolve(scriptPathOrSource));
  const executable = computeExecutableLines(source);

  let covered = 0;
  const uncoveredLines = [];
  for (const lineno of executable) {
    const hit = [...hitsSet].some((h) => {
      const idx = h.lastIndexOf(':');
      const hFile = h.slice(0, idx);
      const hLine = h.slice(idx + 1);
      return Number(hLine) === lineno && (key ? (hFile === key || hFile.endsWith(key)) : true);
    });
    if (hit) covered++;
    else uncoveredLines.push(lineno);
  }

  return {
    total: executable.size,
    covered,
    percent: executable.size ? (covered / executable.size) * 100 : 0,
    uncoveredLines: uncoveredLines.sort((a, b) => a - b),
  };
}

module.exports = { runWithCoverage, runSourceWithCoverage, reportCoverage, computeExecutableLines };

if (require.main === module) {
  const [, , scriptPath, ...args] = process.argv;
  if (!scriptPath) {
    console.error('Usage: bash-coverage.js <script.sh> [args...]');
    process.exit(1);
  }
  const { hits, exitCode, stdout, stderr } = runWithCoverage({ scriptPath, args });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const report = reportCoverage(scriptPath, hits);
  console.log(`\n--- Coverage: ${scriptPath} ---`);
  console.log(`${report.covered}/${report.total} executable lines (${report.percent.toFixed(1)}%)`);
  if (report.uncoveredLines.length) {
    console.log(`Uncovered lines: ${report.uncoveredLines.join(', ')}`);
  }
  process.exit(exitCode ?? 0);
}
