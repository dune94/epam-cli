/**
 * AGENT OUTPUTS ARE AGENT INPUTS. ONE STORE, ONE IMPLEMENTATION.
 *
 * The contract is unchanged from lib/agent-io.sh, which now delegates here:
 *
 *   - the PRODUCER renders its own output; it is the only actor that knows what its fields mean
 *   - the output is published ONCE, carrying WHO produced it
 *   - a consumer DECLARES the kinds it wants, in the order it wants them, and receives them
 *   - ABSENT IS ABSENT: a kind nobody published contributes nothing, and needs no conditional
 *
 * WHY THE LOGIC MOVED TO JAVASCRIPT
 *
 * Producers live in both languages — claude.sh and team-lead-review.sh are shell, while the
 * detective's answer is persisted by spec-mode-runner.js and detective-rerun-step.js. A store with
 * a shell implementation and a JavaScript implementation is two implementations of one thing, and
 * this entire refactor exists because two implementations of one thing drift. So there is one, and
 * the shell binding is a wrapper that calls it.
 *
 * THIS FILE KNOWS NOTHING ABOUT ANY AGENT. It moves opaque text with provenance. The moment it
 * knows what a fix site is, it becomes another place that has to change.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where published outputs live for this run. Under LOG_DIR by default so the pre-run reset clears
 * them with everything else: an input surviving into the next run is how a writer ends up acting
 * on a three-day-old review.
 */
function storeDir(env) {
  const e = env || process.env;
  return e.AGENT_IO_DIR || path.join(e.LOG_DIR || '/tmp', 'agent-io');
}

/** A filesystem-safe key. Kinds and story ids come from data, so they are never used raw. */
function slug(text) {
  return String(text == null ? '' : text).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function pathsFor(story, kind, env) {
  const dir = path.join(storeDir(env), slug(story));
  const file = path.join(dir, slug(kind));
  return { dir, file, from: `${file}.from` };
}

/**
 * publish(from, kind, story, content)
 *
 * LATEST WINS: a second attempt supersedes the first rather than accumulating beside it — a
 * consumer must never receive two answers to the same question and have to guess which is current.
 * EMPTY CLEARS: a producer with nothing to say removes its earlier answer rather than leaving it
 * to be re-served. An agent that falls silent must not keep speaking through an old answer.
 */
function publish(from, kind, story, content, env) {
  if (!from || !kind || !story) return false;
  const { dir, file, from: fromFile } = pathsFor(story, kind, env);

  if (String(content == null ? '' : content).trim() === '') {
    try { fs.unlinkSync(file); } catch (_) { /* nothing published before */ }
    try { fs.unlinkSync(fromFile); } catch (_) { /* nothing published before */ }
    return true;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, String(content));
  fs.writeFileSync(fromFile, String(from));
  return true;
}

/** Did anyone publish this? For callers that must ACT on presence — a gate — never for rendering. */
function present(story, kind, env) {
  const { file } = pathsFor(story, kind, env);
  try { return fs.statSync(file).size > 0; } catch (_) { return false; }
}

/**
 * collect(story, kinds[])
 *
 * The declared kinds, in the DECLARED order, each headed with the kind and the agent that produced
 * it. Order is the consumer's business: "what the plan says" must precede "what the reviewer
 * objected to", and publication order is an accident of scheduling.
 *
 * Provenance is not decoration. A consumer that cannot tell a plan from a demand treats both as
 * equally binding — the writer used to receive sixteen sections of which three each claimed to be
 * the highest priority.
 */
function collect(story, kinds, env) {
  if (!story) return '';
  const parts = [];
  for (const kind of kinds || []) {
    const { file, from: fromFile } = pathsFor(story, kind, env);
    let body;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue; // absent is absent
    }
    if (body === '') continue;
    let from = 'unknown';
    try { from = fs.readFileSync(fromFile, 'utf8') || 'unknown'; } catch (_) { /* keep unknown */ }
    parts.push(`## ${kind} (from: ${from})\n\n${body}\n`);
  }
  return parts.join('\n');
}

/**
 * One published entry: its body and who produced it.
 *
 * collect() renders "## kind (from: agent)" for consumers that have no framing of their own. A
 * consumer whose prompt document DOES frame the input needs the parts, not that heading — two
 * headings in a row read as two sections, and the writer would see its plan of record announced
 * twice under different names.
 */
function read(story, kind, env) {
  const { file, from: fromFile } = pathsFor(story, kind, env);
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  if (body === '') return null;
  let from = 'unknown';
  try { from = fs.readFileSync(fromFile, 'utf8') || 'unknown'; } catch (_) { /* keep unknown */ }
  return { body, from };
}

/** Every kind published for a story, for reporting — never for deciding what to render. */
function published(story, env) {
  const { dir } = pathsFor(story, '', env);
  try {
    return fs.readdirSync(dir).filter((f) => !f.endsWith('.from')).sort();
  } catch (_) {
    return [];
  }
}

module.exports = { publish, collect, read, present, published, storeDir };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'publish') {
      // content arrives on stdin: prompt text contains quotes, backticks and newlines, and an
      // argv round trip through a shell is where those turn into executed commands.
      const [from, kind, story] = rest;
      const content = fs.readFileSync(0, 'utf8');
      publish(from, kind, story, content);
    } else if (cmd === 'collect') {
      const [story, ...kinds] = rest;
      process.stdout.write(collect(story, kinds));
    } else if (cmd === 'present') {
      const [story, kind] = rest;
      process.exit(present(story, kind) ? 0 : 1);
    } else if (cmd === 'published') {
      process.stdout.write(published(rest[0]).join('\n'));
    } else {
      throw new Error(`unknown command '${cmd}' (expected: publish, collect, present, published)`);
    }
  } catch (e) {
    process.stderr.write(`[agent-io] ${(e && e.message) || e}\n`);
    process.exit(2);
  }
}
