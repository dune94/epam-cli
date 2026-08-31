#!/usr/bin/env node
/**
 * A HANDLER EITHER READS ITS INPUT OR SAYS IT COULD NOT.
 *
 * The handlers in this directory are shelled out to for decisions — how many agents a roster holds,
 * which verdicts a gate reached, what a package.json pins. They are handed whatever the filesystem
 * holds at that moment, which includes a file a dead step never wrote, a half-written one, and a
 * log line where JSON was expected.
 *
 * Driven against those inputs on 2026-08-31, ten threw a raw node stack and eight printed a
 * confident value anyway. roster-size.js shows why the second is worse: its own header says it
 * "guards the skip-the-mint path", and handed unparseable JSON it printed 0 and exited 0 — so a
 * CORRUPT roster read exactly like an EMPTY one and the guard waved the run through.
 *
 * A stack trace is not a diagnosis and a default is not an answer. This gives one of two outcomes:
 * the parsed value, or a stated refusal on stderr and a non-zero exit.
 */
const fs = require('fs');

/**
 * readJsonOrRefuse(file, what) -> parsed value, or exits non-zero having said why.
 *
 * `what` names the thing in the operator's terms — "the minted roster", "the AC gate results" —
 * because "ENOENT" names a syscall and the reader has to work out the rest.
 *
 * An empty object or array is a REAL answer and passes through. Only json `null` is refused: every
 * handler that took one went on to read a field from it and threw.
 */
function readJsonOrRefuse(file, what, opts) {
  const name = what || 'its input';
  if (!file) {
    process.stderr.write(`[${scriptName()}] no path was given for ${name} — nothing to read\n`);
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(
      `[${scriptName()}] could not read ${name} at ${file}: ${(e && e.message) || e}\n`
      + '  This is not an empty result — nothing was read at all.\n');
    process.exit(2);
  }
  if (!String(text).trim()) {
    process.stderr.write(
      `[${scriptName()}] ${name} at ${file} is EMPTY. An empty file is not an empty answer: the `
      + 'step that writes it may have died before it wrote anything.\n');
    process.exit(2);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    process.stderr.write(
      `[${scriptName()}] ${name} at ${file} is not valid JSON and could not be parsed: `
      + `${(e && e.message) || e}\n`
      + '  Returning a default here would be indistinguishable from a real answer.\n');
    process.exit(2);
  }
  if (value === null) {
    process.stderr.write(
      `[${scriptName()}] ${name} at ${file} parsed to null — there are no fields to read from it.\n`);
    process.exit(2);
  }
  // VALID JSON OF THE WRONG SHAPE is the second half of this class. `{}` where an array was
  // expected produced "results.forEach is not a function" — a node internal thrown mid-run, naming
  // neither the file that was wrong nor what it should have held. A handler that knows the shape it
  // needs should say so, and be told plainly when it does not get it.
  const want = opts && opts.expect;
  if (want) {
    const got = Array.isArray(value) ? 'array' : typeof value;
    if (want !== got) {
      process.stderr.write(
        `[${scriptName()}] ${name} at ${file} is an ${got}, but this reads it as an ${want}. `
        + 'The file parsed, so this is not a corruption — it is the wrong thing in the right place, '
        + 'which usually means an earlier step wrote where it should not have.\n');
      process.exit(2);
    }
  }
  return value;
}

/** The handler doing the reading, so a message in a shell log says which program spoke. */
function scriptName() {
  try { return require('path').basename(process.argv[1] || 'handler'); } catch { return 'handler'; }
}

module.exports = { readJsonOrRefuse };
