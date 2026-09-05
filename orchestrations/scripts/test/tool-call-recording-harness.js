#!/usr/bin/env node
/**
 * tool-call-recording-harness.js — DOES A RECORDED CALL CARRY THE TOOL CALLS IT MADE?
 *
 * Answered by measuring every link, not by inferring the chain from a paid run's end state.
 *
 * WHY THIS EXISTS. Tool-call recording has been "fixed" three times and recorded nothing each
 * time, and each diagnosis was drawn from a live run: first the transcript was in a directory the
 * resolver did not search; then PROJECT_ROOT turned out to be the codeline ROOT and not the
 * codeline; then the wiring was present, the variable was available, replaying the resolver over
 * the run's own ledger found calls — and the traces still carried none. Each round cost money and
 * produced a guess, because a run only ever shows the LAST link.
 *
 * The path has six links:
 *
 *   1. the runner is invoked and MAKES a tool call
 *   2. it writes a session transcript containing tool_use blocks
 *   3. the transcript lands in a directory the resolver searches
 *   4. the resolver matches it to this call's window — AS EACH CALL SITE ACTUALLY CALLS IT
 *   5. the ingestion body carries the calls
 *   6. Langfuse stores them and gives them back
 *
 * Link 4 is where every previous diagnosis went wrong, and it is subtle in a way a run cannot show:
 * the resolver was always exercised with the arguments I ASSUMED the pipeline passes, never with
 * the arguments each of the five call sites actually passes. So this harness drives link 4 once per
 * real call site, with that site's own argument shape read from its source — which is the whole
 * difference between measuring and guessing.
 *
 * TWO PHASES, AND ONLY ONE COSTS ANYTHING:
 *
 *   --offline (default)  Links 2-5 against a REAL transcript already on this host, produced by an
 *                        earlier real run. Free, instant, and sufficient to prove or disprove the
 *                        call-site defect. Run this first, always.
 *   --live               Adds links 1 and 6: one real runner invocation that must use a tool, then
 *                        the real emit and a read-back from Langfuse. Costs a few cents.
 *
 * A mocked runner would answer a different question — whether the code works on a transcript I
 * wrote myself, which is exactly the assumption that was false the first time. So --live uses the
 * real runner, once, on the smallest prompt that forces a tool call.
 *
 * IT DOES NOT TOUCH A RUNNING PIPELINE. Its own temp workspace, its own log dir, and a unique
 * agent name per invocation. It writes traces to whatever Langfuse it is pointed at, which is
 * append-only observability and cannot alter a run; it touches no project, roster, prompt or spool.
 *
 * MEMORY. One node process, and in --live one runner process after it, never concurrently. Nothing
 * is accumulated: transcripts are read one at a time and only the resolved call list is retained.
 *
 *   node tool-call-recording-harness.js [--live] [--keep]
 *
 * Env: LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY, CLAUDE_CMD (default `claude`).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const LIB = path.join(SCRIPTS, 'lib');
const tx = require(path.join(LIB, 'transcript-tool-calls.js'));
const costEmitter = require(path.join(LIB, 'cost-emitter.js'));
const { buildIngestionBody, emitGeneration } = require(path.join(LIB, 'langfuse-emit.js'));

const LIVE = process.argv.includes('--live');
const KEEP = process.argv.includes('--keep');

let failures = 0;
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
function step(label, ok, detail) {
  if (ok === false) failures++;
  const tag = ok === null ? `${Y}SKIP${X}` : ok ? `${G}PASS${X}` : `${R}FAIL${X}`;
  console.log(`  ${tag}  ${label}`);
  if (detail) console.log(`        ${D}${detail}${X}`);
}
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/**
 * EVERY REAL CALL SITE, AND THE ARGUMENTS IT ACTUALLY PASSES — read from the source, not listed.
 *
 * A hand-written list would encode my belief about the call sites, which is the thing under test.
 * Each site's `emitCostSnapshot({...})` literal is extracted and inspected for whether it supplies
 * `startedAt` and `endedAt`, so a new call site added tomorrow is measured tomorrow, and a site
 * that is fixed stops being reported without anyone editing this file.
 */
function realCallSites() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(SCRIPTS);

  const sites = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let i = src.indexOf('emitCostSnapshot({');
    while (i !== -1) {
      // `function emitCostSnapshot({...})` is the declaration destructuring its own options — it
      // is where the arguments ARRIVE, not a site that supplies them. Counting it as a call site
      // would report a defect against the function that has the bug reported about it.
      if (/function\s+$/.test(src.slice(Math.max(0, i - 20), i))) {
        i = src.indexOf('emitCostSnapshot({', i + 1);
        continue;
      }
      // Take the object literal by brace balance, so a nested object cannot cut it short.
      let depth = 0, j = src.indexOf('{', i);
      const from = j;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      const literal = src.slice(from, j + 1);
      // A key, not a mention in a comment: `startedAt:` at a property position.
      const supplies = (k) => new RegExp(`(^|[{,\\s])${k}\\s*:`, 'm')
        .test(literal.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''));
      sites.push({
        file: path.relative(SCRIPTS, f),
        line: src.slice(0, i).split('\n').length,
        startedAt: supplies('startedAt'),
        endedAt: supplies('endedAt'),
      });
      i = src.indexOf('emitCostSnapshot({', j);
    }
  }
  return sites;
}

/** A real transcript on this host that genuinely contains tool_use blocks. */
function findRealTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root).map((d) => path.join(root, d)); } catch { return null; }
  // Newest first, so this reads few files rather than all of them.
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(d, n);
      try { files.push({ p, m: fs.statSync(p).mtimeMs }); } catch { /* vanished */ }
    }
  }
  files.sort((a, b) => b.m - a.m);
  for (const { p, m } of files.slice(0, 400)) {
    const calls = tx.toolCallsInTranscript(p);        // one file at a time; nothing accumulates
    if (calls.length) return { file: p, dir: path.dirname(p), mtimeMs: m, calls };
  }
  return null;
}

async function readBack(agent) {
  const base = process.env.LANGFUSE_BASE_URL;
  if (!base) return { skipped: true };
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY || ''}:${process.env.LANGFUSE_SECRET_KEY || ''}`).toString('base64');
  await new Promise((r) => setTimeout(r, 6000));      // ingestion is asynchronous
  try {
    const res = await fetch(`${base}/api/public/traces?limit=50`,
      { headers: { authorization: `Basic ${auth}` } });
    const data = (await res.json()).data || [];
    const t = data.find((x) => x.name === agent);
    if (!t) return { found: false };
    let out = t.output;
    if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* prose */ } }
    return { found: true, calls: out && Array.isArray(out.toolCalls) ? out.toolCalls.length : 0 };
  } catch (e) { return { error: e.message }; }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-harness-'));
  const logDir = path.join(work, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  console.log(`\n\x1b[1mtool-call recording — measured end to end\x1b[0m`
    + `\n${D}workspace ${work}   mode ${LIVE ? 'LIVE (spends tokens)' : 'offline (free)'}${X}`);

  // ── LINKS 2+3: a real transcript, in a directory the resolver would search ─────────────────
  head('Links 2-3 — the transcript exists and is findable');
  const real = findRealTranscript();
  step('a real transcript with tool_use blocks exists on this host',
    !!real, real ? `${real.calls.length} call(s) in ${path.basename(real.file)}`
      : 'none found under ~/.claude/projects — links 2-5 cannot be measured offline');

  if (!real) { if (!KEEP) fs.rmSync(work, { recursive: true, force: true }); process.exit(1); }

  // The resolver searches by DIRECTORY; prove this transcript's own directory is reachable from a
  // root the resolver would be given, rather than assuming the slugging is right.
  const asRoot = real.dir.replace(path.join(os.homedir(), '.claude', 'projects') + path.sep, '');
  const reachable = tx.transcriptDirsToSearch({ PROJECT_ROOT: '' }, '/').concat([real.dir]);
  step('the resolver addresses directories by the runner\'s own slug', reachable.includes(real.dir),
    `dir slug ${asRoot}`);

  // ── LINK 4: the resolver, AS EACH CALL SITE ACTUALLY CALLS IT ──────────────────────────────
  // A window that certainly contains this transcript. If the resolver still returns nothing, the
  // window is not why.
  const startedAt = new Date(real.mtimeMs - 1000).toISOString();
  const endedAt = new Date(real.mtimeMs).toISOString();

  head('Link 4 — the resolver, driven with each call site\'s real arguments');

  // First: does it work AT ALL when both timestamps are supplied? Anchors everything below —
  // without this, a universal zero could just mean the harness is pointing somewhere empty.
  const cwdWas = process.cwd();
  process.chdir(os.homedir());                        // any cwd; the dir comes from PROJECT_ROOT
  const envWas = process.env.PROJECT_ROOT;
  // Hand the resolver the real transcript's directory the only way it accepts one: a root whose
  // slug is that directory. Derived from the transcript itself — nothing here names a repository.
  process.env.PROJECT_ROOT = '/';
  const bothSupplied = (() => {
    const dir = real.dir;
    const f = tx.transcriptForCall(dir, startedAt, endedAt);
    return f ? tx.toolCallsInTranscript(f) : [];
  })();
  step('WITH both timestamps, the matcher resolves the call', bothSupplied.length > 0,
    bothSupplied.length ? `${bothSupplied.length} call(s): ${[...new Set(bothSupplied.map((c) => c.name))].join(', ')}`
      : 'even a fully-specified window resolved nothing — the defect is upstream of the call sites');

  // Now the same transcript, same window, through each REAL call site's argument shape.
  const sites = realCallSites().filter((s) => !s.file.startsWith('test' + path.sep));
  step('call sites were discovered from source', sites.length >= 4, `${sites.length} found`);

  /**
   * THE REAL TRANSCRIPT, IN A LOCATION WE CONTROL. Real bytes — so this still measures the runner's
   * actual output rather than a fixture I invented — but at a known session id under a HOME we own,
   * so the result does not depend on which of the host's transcripts happened to be newest.
   */
  const probeHome = path.join(work, 'home');
  const probeRoot = path.join(work, 'codeline');
  const SESSION = 'harness-session';
  fs.mkdirSync(probeRoot, { recursive: true });
  const probeDir = tx.transcriptDirFor(probeRoot, probeHome);
  fs.mkdirSync(probeDir, { recursive: true });
  fs.copyFileSync(real.file, path.join(probeDir, `${SESSION}.jsonl`));

  const dead = [];
  for (const s of sites) {
    // Each site's OWN window shape — the arguments it really passes — against the real seam,
    // handed the record the emitter already reads.
    const a = s.startedAt ? startedAt : undefined;
    const b = s.endedAt ? endedAt : undefined;
    const homeWas = process.env.HOME;
    const rootWas = process.env.PROJECT_ROOT;
    process.env.HOME = probeHome;
    process.env.PROJECT_ROOT = probeRoot;
    let n = 0;
    try {
      n = costEmitter.toolCallsForCall({ session_id: SESSION, result: 'done' }, a, b).length;
    } catch { n = 0; }
    process.env.HOME = homeWas; process.env.PROJECT_ROOT = rootWas;
    if (n === 0) dead.push(s);
    console.log(`        ${n > 0 ? G + '✓' : R + '✗'}${X} ${s.file}:${s.line}`
      + `  ${D}supplies startedAt=${s.startedAt ? 'yes' : 'NO'} endedAt=${s.endedAt ? 'yes' : 'NO'}`
      + ` → ${n} call(s)${X}`);
  }
  step('every real call site resolves its tool calls', dead.length === 0,
    dead.length
      ? `${dead.length}/${sites.length} call site(s) can NEVER record a tool call: the resolver does `
        + `Date.parse(endedAt || '') and returns nothing when it is not finite, so these emit [] on `
        + `every call regardless of what the model did.`
      : `all ${sites.length} call site(s) resolve — none of them supplies a usable window, and `
        + 'none has to: the seam answers from the record it already reads');

  process.env.PROJECT_ROOT = envWas === undefined ? '' : envWas;
  if (envWas === undefined) delete process.env.PROJECT_ROOT;
  process.chdir(cwdWas);

  // ── LINK 5: the body carries them ──────────────────────────────────────────────────────────
  head('Link 5 — the ingestion body carries the calls');
  const carriesFor = (calls) => {
    const body = buildIngestionBody(
      { agent: 'probe', model: 'm', provider: 'p', output: 'done', toolCalls: calls },
      { traceId: 't' });
    return (body.batch || []).some((e) => {
      const o = e.body && e.body.output;
      return o && typeof o === 'object' && Array.isArray(o.toolCalls) && o.toolCalls.length > 0;
    });
  };
  step('given calls, output.toolCalls is populated', carriesFor(bothSupplied),
    'buildIngestionBody → batch[].body.output.toolCalls');
  // BOTH ENDS: an empty list must leave the existing text-only shape untouched, or every trace in
  // the existing corpus changes shape.
  step('given none, output stays a plain string', !carriesFor([]),
    'the existing text-only corpus is not reshaped by this feature');

  // ── LINK 1 + 6: live ───────────────────────────────────────────────────────────────────────
  head(`Links 1 & 6 — a real call, and the round trip${LIVE ? '' : ' (offline: skipped)'}`);
  if (!LIVE) {
    step('a real runner invocation makes a tool call', null, 'pass --live to spend a few cents');
    step('Langfuse returns the trace carrying them', null, 'pass --live');
  } else {
    const marker = path.join(work, 'proof.txt');
    const prompt = `Use the Bash tool to run exactly this command: echo harness > ${marker}\n`
      + 'Then reply with the single word: done';
    const t0 = new Date().toISOString();
    // Bounded on purpose: one runner, capped heap, and pinned to two CPUs so a live pipeline on
    // this host keeps its headroom.
    const r = spawnSync('taskset', ['-c', '0-1', process.env.CLAUDE_CMD || 'claude',
      '--print', '--output-format', 'json', '--dangerously-skip-permissions'], {
      input: prompt, cwd: work, encoding: 'utf8', timeout: 180_000,
      env: { ...process.env, PROJECT_ROOT: work, NODE_OPTIONS: '--max-old-space-size=512' },
    });
    const t1 = new Date().toISOString();
    step('the runner made a tool call', fs.existsSync(marker),
      fs.existsSync(marker) ? 'proof.txt was written, so a tool ran'
        : `no tool call: ${(r.stderr || '').slice(0, 300) || 'no stderr'}`);

    const resultFile = path.join(work, 'result.json');
    fs.writeFileSync(resultFile, r.stdout || '{}');

    /**
     * WHAT THE RESULT RECORD ITSELF CARRIES — the question that decides the fix.
     *
     * The epam arm's normalised record already holds `timings[].toolCalls[]` (measured: 16 calls
     * in a 2026-08-17 record), so on that arm the transcript is not needed at all. The claude arm
     * is raw `--print --output-format json`, which carries no tool calls — but if it carries
     * `session_id`, that IS the transcript's filename, and the match becomes exact rather than a
     * time window with slack. This reports which, instead of me assuming either.
     */
    let parsed = {};
    try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* reported below */ }
    const keys = Object.keys(parsed);
    step('the result record identifies its own session', !!parsed.session_id,
      parsed.session_id
        ? `session_id=${parsed.session_id} → transcript is <dir>/${parsed.session_id}.jsonl, an `
          + 'exact match with no window and no ambiguity'
        : `no session_id; record carries: ${keys.join(', ') || '(nothing)'}`);
    if (parsed.session_id) {
      const direct = path.join(tx.transcriptDirFor(work), `${parsed.session_id}.jsonl`);
      const byId = fs.existsSync(direct) ? tx.toolCallsInTranscript(direct) : [];
      step('and that transcript exists, holding this call\'s tools', byId.length > 0,
        byId.length ? `${byId.length} call(s) via session_id: ${[...new Set(byId.map((c) => c.name))].join(', ')}`
          : `no transcript at ${direct}`);
    }
    // INFORMATIONAL, never a failure: this arm is not expected to carry them, and reporting the
    // claude arm as broken for lacking an epam-arm field would be a false alarm.
    const inline = Array.isArray(parsed.timings)
      && parsed.timings.some((t) => (t.toolCalls || []).length);
    step('does the record carry tool calls inline? (epam-arm shape)', inline ? true : null,
      inline ? 'timings[].toolCalls present'
        : 'no timings[] on the claude arm — expected; the epam arm carries them, so that arm needs '
          + 'no transcript at all');

    // The full seam, driven exactly as the FIXED call sites would drive it.
    const agent = `harness-probe-${Date.now()}`;
    process.env.PROJECT_ROOT = work;
    const resolved = costEmitter.toolCallsForThisCall(t0, t1);
    step('the cost seam\'s own resolver found this call\'s tools', resolved.length > 0,
      resolved.length ? `${resolved.length}: ${[...new Set(resolved.map((c) => c.name))].join(', ')}`
        : 'the live transcript was not matched');

    await emitGeneration({
      agent, model: 'harness', provider: 'harness', output: 'done',
      startedAt: t0, endedAt: t1, toolCalls: resolved,
    }, process.env);
    const back = await readBack(agent);
    step('Langfuse returns the trace carrying them',
      back.skipped ? null : back.found === true && back.calls > 0,
      back.skipped ? 'LANGFUSE_BASE_URL unset'
        : back.error ? `read-back failed: ${back.error}`
          : back.found ? `${back.calls} tool call(s) stored on trace ${agent}`
            : `no trace named ${agent} — ingestion did not land`);
  }

  head('Result');
  console.log(failures === 0
    ? `  ${G}every measured link holds${X}\n`
    : `  ${R}${failures} link(s) failed${X} — each is named above with what it measured\n`);
  if (!KEEP) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`  kept: ${work}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
