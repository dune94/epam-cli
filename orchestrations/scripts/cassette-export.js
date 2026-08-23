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

const BASE = () => process.env.LANGFUSE_BASE_URL || 'http://localhost:3100';

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

  store.writeManifest(out, {
    session,
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
  if (unnamed) process.stdout.write(`  ${unnamed} trace(s) carried no seam name and were not recorded\n`);
}

main().catch((e) => {
  process.stderr.write(`${(e && e.message) || e}\n`);
  process.exit(1);
});
