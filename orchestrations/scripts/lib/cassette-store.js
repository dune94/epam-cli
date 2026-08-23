/**
 * RECORDED MODEL TURNS, ON DISK, SO A REHEARSAL COSTS NOTHING.
 *
 * Every bug that killed a run this month was plumbing — an unbound variable, a function used and
 * never imported, an env var handed the wrong directory. None of them needed a model to find, and
 * all of them cost real tokens to find, because the only way to exercise the pipeline end to end
 * was to run it against paid APIs.
 *
 * Langfuse has been recording every turn of every run all along: 81,396 observations, each with
 * the prompt that produced it and the assistant turn that came back, named by SEAM and grouped by
 * SESSION. A rehearsal does not need to generate anything — it needs to replay what a real run
 * already said.
 *
 * WHAT A CASSETTE IS. One recorded run, as a directory:
 *
 *   <cassette>/manifest.json          the session it came from, when, and what it contains
 *   <cassette>/<seam>.json            that seam's assistant turns, in the order they happened
 *
 * A turn is `{text, toolCalls}` — exactly what the provider returns. The agent loop is NOT
 * recorded: it runs for real against the replayed turns, so a recorded `bash` call really runs
 * and a recorded write really writes. That is what makes the rehearsal faithful rather than a
 * mime of one: the writer's code appears on disk because the writer's own recorded commands put
 * it there, and every gate downstream judges real artefacts.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not match on prompt text. Prompts embed temp paths,
 * timestamps and story state, so hashing them would miss on nearly every turn and the rehearsal
 * would be a slow way to produce cache misses. Turns are replayed IN ORDER, per seam. If the
 * pipeline asks for a turn the recording does not have, that means the code now takes a path the
 * recorded run did not — which is a finding, and is reported as one rather than being papered
 * over with an invented answer.
 */
const fs = require('fs');
const path = require('path');

/** Read a cassette's manifest, or explain why there is none. */
function loadManifest(cassetteDir) {
  const p = path.join(cassetteDir, 'manifest.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(
      `[cassette] no manifest at ${p}: ${e && e.message}. A cassette is a directory produced by `
      + 'cassette-export.js from a recorded Langfuse session; an arbitrary directory is not one.');
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[cassette] manifest at ${p} is not valid JSON: ${e && e.message}`);
  }
  if (!m || typeof m !== 'object' || !m.session) {
    throw new Error(`[cassette] manifest at ${p} names no session — it cannot say what it recorded.`);
  }
  return m;
}

/**
 * A seam's recorded turns, in order.
 *
 * A seam the recording never exercised is NOT an empty list: an empty list would let a caller
 * replay it as "the model said nothing", which is a legitimate recorded answer and would be
 * indistinguishable from having no recording at all.
 */
function turnsFor(cassetteDir, seam) {
  const p = path.join(cassetteDir, `${safeSeamFile(seam)}.json`);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  let turns;
  try {
    turns = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[cassette] '${seam}' turns at ${p} are not valid JSON: ${e && e.message}`);
  }
  if (!Array.isArray(turns)) {
    throw new Error(`[cassette] '${seam}' at ${p} is not a list of turns.`);
  }
  return turns;
}

/**
 * A seam name is a file name here, and seam names carry characters a path must not
 * ("qa-gate:sast"). Encoded rather than stripped: stripping would map two distinct seams onto one
 * file, and the collision would silently give one seam the other's answers.
 */
function safeSeamFile(seam) {
  // FIXED WIDTH — '~' plus exactly four hex digits. A variable-width escape is ambiguous: a seam
  // whose name contains "~ab" followed by literal hex characters decodes to something other than
  // what was encoded, and the collision hands one seam another's recorded answers.
  return String(seam).replace(/[^A-Za-z0-9._-]/g,
    (c) => `~${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Which seams a cassette holds — for reporting what a rehearsal can and cannot cover. */
function seamsIn(cassetteDir) {
  let files;
  try {
    files = fs.readdirSync(cassetteDir);
  } catch (e) {
    throw new Error(`[cassette] cannot read ${cassetteDir}: ${e && e.message}`);
  }
  return files.filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => decodeSeamFile(f.slice(0, -5)))
    .sort();
}

function decodeSeamFile(name) {
  return String(name).replace(/~([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Write one seam's turns. Used by the exporter; kept here so the format has ONE definition. */
function writeSeam(cassetteDir, seam, turns) {
  fs.mkdirSync(cassetteDir, { recursive: true });
  fs.writeFileSync(path.join(cassetteDir, `${safeSeamFile(seam)}.json`),
    `${JSON.stringify(turns, null, 2)}\n`);
}

function writeManifest(cassetteDir, manifest) {
  fs.mkdirSync(cassetteDir, { recursive: true });
  fs.writeFileSync(path.join(cassetteDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`);
}

module.exports = {
  loadManifest, turnsFor, seamsIn, writeSeam, writeManifest, safeSeamFile, decodeSeamFile,
};
