#!/usr/bin/env node
/**
 * EXPORT A RECORDED RUN FROM LANGFUSE INTO A CASSETTE.
 *
 * Reads nothing but Langfuse, writes nothing but the cassette directory. No model is called and
 * no run is started, so this is free and repeatable.
 *
 * Usage:
 *   cassette-export.js --session <id> --out <dir>
 *   cassette-export.js --list
 *
 * The traces of a session are the turns of that run: each is named for the SEAM that produced it
 * and carries the assistant turn in `output` as {text, toolCalls}. Ordered by their timestamp,
 * they are the sequence a replay hands back.
 */
const fs = require('fs');
const path = require('path');
const store = require(path.join(__dirname, 'lib', 'cassette-store.js'));

function envAuth() {
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!pub || !sec) {
    throw new Error(
      'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both required to read recorded runs. '
      + 'They are the same credentials the pipeline already uses to WRITE them.');
  }
  return `Basic ${Buffer.from(`${pub}:${sec}`).toString('base64')}`;
}

// THE SERVICE'S URL HAS ONE HOME: config/services.json, which also names the override env var.
// A literal fallback here was a second home — moving the service meant editing config AND
// hunting for the literal, and wherever it was missed the literal won.
function declaredServiceUrl(name) {
  try {
    const p = require('path').join(__dirname, '..', 'config', 'services.json');
    const s = JSON.parse(require('fs').readFileSync(p, 'utf8')).services[name];
    return (s.env && process.env[s.env]) || s.url;
  } catch { return ''; }
}
const BASE = () => declaredServiceUrl('langfuse');

async function api(pathAndQuery) {
  const url = `${BASE()}${pathAndQuery}`;
  const res = await fetch(url, { headers: { Authorization: envAuth() } });
  if (!res.ok) {
    throw new Error(`[cassette-export] ${url} answered ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Every trace of a session, oldest first — pagination included, because a run has thousands. */
async function tracesOf(session) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const j = await api(`/api/public/traces?sessionId=${encodeURIComponent(session)}&limit=100&page=${page}`);
    const batch = (j && j.data) || [];
    out.push(...batch);
    const total = ((j && j.meta) || {}).totalItems;
    if (!batch.length || (Number.isFinite(total) && out.length >= total)) break;
    if (page > 500) break;                                  // a bounded loop, not an open one
  }
  // Oldest first. A run's meaning is its ORDER, and the API answers newest-first.
  return out.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

/**
 * The assistant turn a trace recorded, in the provider's own shape.
 *
 * A trace whose output is absent is kept as an EMPTY TURN rather than dropped: a model that
 * returned nothing is a real thing that happened, it is how several of this month's failures
 * looked, and a rehearsal that quietly skipped those turns would be rehearsing a run that never
 * occurred.
 */
function turnOf(trace) {
  const o = trace && trace.output;
  if (o && typeof o === 'object') {
    return { text: String(o.text || ''), toolCalls: Array.isArray(o.toolCalls) ? o.toolCalls : [] };
  }
  if (typeof o === 'string') return { text: o, toolCalls: [] };
  return { text: '', toolCalls: [] };
}

/**
 * WHICH TREES A REHEARSAL WILL WRITE INTO — derived from the recording, never named here.
 *
 * Replay executes the recorded tool calls for real, so a rehearsal touches whatever the recorded
 * run touched. Isolating it means knowing which trees those are, and the only honest source for
 * that is the recording itself: a list written into this script would be a guess about one
 * machine's layout and would silently under-cover the moment a project moved.
 *
 * A "root" here is a git repository: the recorded paths are collected, and each is walked up to
 * the nearest directory containing .git. That is the unit a codeline is checked out as, the unit
 * a reset operates on, and the unit an overlay can discard whole.
 *
 * A path under no repository is reported separately rather than dropped -- an unisolated write is
 * exactly what the operator needs told about, and silence would read as "nothing to isolate".
 */
function rootsTouchedBy(traces) {
  const paths = new Set();
  const ABSOLUTE = /(\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/g;
  for (const t of traces) {
    const blob = JSON.stringify((t && t.output) || '');
    for (const m of blob.matchAll(ABSOLUTE)) paths.add(m[1]);
  }

  const roots = new Set();
  const outside = new Set();
  for (const p of paths) {
    let dir = path.dirname(p);
    let found = null;
    // Bounded walk: up to the filesystem root, and never past it.
    for (let i = 0; i < 64 && dir && dir !== '/' && dir !== path.dirname(dir); i += 1) {
      if (fs.existsSync(path.join(dir, '.git'))) { found = dir; break; }
      dir = path.dirname(dir);
    }
    if (found) roots.add(found); else outside.add(p);
  }
  return { roots: [...roots].sort(), pathsOutsideAnyRepo: outside.size };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.includes('--list')) {
    const j = await api('/api/public/sessions?limit=25');
    for (const s of (j && j.data) || []) process.stdout.write(`${s.id}\t${s.createdAt}\n`);
    return;
  }

  const session = arg('--session');
  const out = arg('--out');
  if (!session || !out) {
    process.stderr.write('usage: cassette-export.js --session <id> --out <dir>   (or --list)\n');
    process.exit(2);
  }

  const traces = await tracesOf(session);
  if (!traces.length) {
    throw new Error(
      `[cassette-export] session '${session}' has no traces. Either the id is wrong or that run `
      + 'produced no model calls — an empty cassette would rehearse nothing and is not written.');
  }

  const bySeam = new Map();
  const models = new Map();
  for (const t of traces) {
    const seam = String(t.name || '').trim();
    // A trace with no name cannot be attributed to a seam, and a replay is looked up BY seam. Kept
    // out of the cassette and counted, so the export says what it could not place rather than
    // silently recording fewer turns than the run had.
    if (!seam) continue;
    if (!bySeam.has(seam)) bySeam.set(seam, []);
    bySeam.get(seam).push(turnOf(t));
    const md = (t && t.metadata) || {};
    if (md.model && !models.has(seam)) models.set(seam, { model: md.model, provider: md.provider || '' });
  }

  const unnamed = traces.filter((t) => !String(t.name || '').trim()).length;
  for (const [seam, turns] of bySeam) store.writeSeam(out, seam, turns);

  const touched = rootsTouchedBy(traces);

  store.writeManifest(out, {
    session,
    // What a rehearsal of this cassette will write into. rehearse.sh isolates exactly these.
    roots: touched.roots,
    pathsOutsideAnyRepo: touched.pathsOutsideAnyRepo,
    exportedFrom: BASE(),
    traceCount: traces.length,
    unattributableTraces: unnamed,
    seams: [...bySeam.keys()].sort().map((s) => ({
      seam: s,
      turns: bySeam.get(s).length,
      ...(models.get(s) || {}),
    })),
  });

  process.stdout.write(`${bySeam.size} seam(s), ${traces.length} turn(s) -> ${out}\n`);
  process.stdout.write(`  rehearsing this writes into: ${touched.roots.join(', ') || '(no repository)'}\n`);
  if (touched.pathsOutsideAnyRepo) {
    process.stdout.write(`  ${touched.pathsOutsideAnyRepo} recorded path(s) lie under no repository\n`);
  }
  if (unnamed) process.stdout.write(`  ${unnamed} trace(s) carried no seam name and were not recorded\n`);
}

main().catch((e) => {
  process.stderr.write(`${(e && e.message) || e}\n`);
  process.exit(1);
});
