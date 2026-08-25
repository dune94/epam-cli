#!/usr/bin/env node
/**
 * LOAD MOCKSERVER EXPECTATIONS FOR EVERY SEAM — DERIVED, NEVER LISTED.
 *
 * The pipeline needs NO changes to run against a mock: ProviderChain reads OPENROUTER_BASE_URL and
 * MINIMAX_BASE_URL from the environment already. What was missing was a faithful response per seam,
 * and the first attempts hand-mapped seam -> capture file in a throwaway script, which is a list to
 * maintain and drift from — the thing this project forbids.
 *
 * Nothing is listed here. Everything is derived:
 *
 *   WHICH SEAMS EXIST      invocation-profiles.json — the registry that already declares them
 *   HOW TO MATCH A REQUEST the seam's own prompt text, read from its template
 *   WHAT TO ANSWER WITH    that seam's REAL captured reply, found in the run archive by convention
 *
 * Add a seam, and it is covered. Change a prompt, and the key follows it. Nothing is authored: a
 * body is a recording of what a model really said, or the seam is skipped and reported as uncovered
 * rather than answered with something invented.
 *
 * Usage: node mock-expectations.js [--host http://localhost:1080] [--archive <dir>]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const HOST = arg('--host', 'http://localhost:1080');
const ROOT = path.join(__dirname, '..', '..');
const REG = path.join(ROOT, 'orchestrations/agents/invocation-profiles.json');
const TPL = path.join(ROOT, 'orchestrations/prompts/templates');
const ARCHIVE_ROOT = path.join(ROOT, 'orchestrations/logs/archive');

/** Every seam the registry declares, with the template it renders. */
function seams() {
  const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
  const out = [];
  (function walk(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') {
        if (typeof v.template === 'string') out.push({ seam: k, template: v.template });
        walk(v);
      }
    }
  }(reg.profiles || reg));
  return out;
}

/**
 * The match key: the first substantial line of the seam's own prompt.
 *
 * A prompt's opening sentence is what distinguishes it from every other prompt, and it travels in
 * the request body verbatim — so it identifies the seam without anything being written down here.
 */
function matchKey(template) {
  const f = path.join(TPL, `${template}.json`);
  if (!fs.existsSync(f)) return null;
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  const body = t.bodies ? Object.values(t.bodies).join('\n') : String(t.body || '');
  const line = body.split('\n').find((l) => l.trim().length > 45 && !/^__/.test(l.trim()));
  return line ? line.trim().slice(0, 50) : null;
}

/**
 * A REAL captured reply for this seam.
 *
 * runClaude writes每 invocation to <logDir>/<something>.log with a "# Output" marker, and the
 * pre-run reset archives the directory. So the archive is a library of what models really said.
 *
 * ARCHIVES WRITTEN BY A MOCKED RUN ARE EXCLUDED. A mock run's own answers land in the same log
 * directory and get archived like any other, so replaying them would feed the library its own
 * output and call it evidence. Any archive whose reply came from the replay model is skipped.
 */
/**
 * A CASSETTE — a recorded run's replies, one file per seam invocation.
 *
 * orchestrations/cassettes/<run>/<seam>.json holds {"0": {"text": "<what the model said>"}}, and the
 * filename IS the seam (with ~00xx escapes for ':', ' ' and '·'). That makes it the most direct
 * capture source in the repo: no marker to find, no log to parse, and named by the thing it answers
 * for. 149 of them exist across three recorded runs and nothing was using them.
 */
/**
 * LANGFUSE — THE COMPLETE RECORDING LIBRARY.
 *
 * Every traced call the pipeline has ever made is here: 83,870 traces at the time of writing, each
 * NAMED BY ITS SEAM, each carrying the model's real output. The cassettes in this repo are exports
 * of it, which is why they cover only a fraction — this is the source they came from.
 *
 * Nothing is authored and nothing is listed: ask for a trace named after the seam, take the reply
 * it recorded. A seam with no trace is reported as uncovered rather than answered with an invention.
 *
 * ':plan' traces are the planning pass, not the answer, and are skipped.
 */
async function langfuseReply(seam) {
  const base = process.env.LANGFUSE_BASE_URL || 'http://localhost:3100';
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!pub || !sec) return null;
  const auth = Buffer.from(`${pub}:${sec}`).toString('base64');
  const get = (p) => new Promise((resolve) => {
    const u = new URL(base + p);
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'GET', headers: { authorization: `Basic ${auth}` } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.end();
  });

  // A SEAM THAT ACTS IS A CONVERSATION, NOT AN ANSWER.
  //
  // roster-specialiser reads the canonical roster, dumps personas in batches, then writes its file
  // — several turns, each its own trace, all sharing the run's sessionId. Replaying any ONE of them
  // reproduces a fragment: the capture I first served was an exploratory read, so the roster was
  // never written and the contract refused it three runs running.
  //
  // So turns are grouped by session and replayed IN ORDER. Sessions whose replies came from a mock
  // are skipped — a replay of a replay is not evidence.
  const list = await get(`/api/public/traces?name=${encodeURIComponent(seam)}&limit=100`);
  const candidates = [];
  for (const t of ((list && list.data) || [])) {
    if (!t || !t.id || /:plan$/.test(String(t.name || ''))) continue;
    const full = await get(`/api/public/traces/${encodeURIComponent(t.id)}`);
    for (const o of (((full && full.observations) || [])).slice().reverse()) {
      const out = o && o.output;
      const text = typeof out === 'string' ? out
        : (out && (out.content || out.text || (out.choices && out.choices[0]
            && out.choices[0].message && out.choices[0].message.content)));
      if (typeof text !== 'string' || !text.trim()) continue;

      // NEVER REPLAY A REPLAY.
      //
      // A mocked run is traced like any other, so this server now holds MY OWN mock answers filed
      // under the seam they were served to. Taking the newest trace fed the catch-all `{}` straight
      // back into the pipeline, and roster-specialiser "wrote no roster" three runs in a row for a
      // reason I had introduced. A recording library that ingests its own replay stops being
      // evidence of anything.
      const body = text.trim();
      if (body === '{}' || /^\{"text"\s*:\s*"\{\}"/.test(body)) continue;
      if (String(o.model || '') === 'replay') continue;

      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* prose is a real reply too */ }
      const toolCalls = Number((o.metadata || {}).toolCalls || 0);
      // THE CALLS THEMSELVES, not just how many. A seam that DELIVERS by tool call cannot be
      // replayed from its text: roster-specialiser writes its roster with `bash`, and serving the
      // sentence it wrote afterwards leaves no file behind, which the contract then refuses.
      let calls = [];
      try {
        const raw = typeof o.output === 'string' ? JSON.parse(o.output) : o.output;
        if (raw && Array.isArray(raw.toolCalls)) calls = raw.toolCalls;
      } catch { /* no structured calls on this observation */ }
      candidates.push({ body, file: `langfuse:${t.id.slice(0, 12)}`, parsed, toolCalls,
        len: body.length, calls, session: t.sessionId, ts: t.timestamp });
      break;
    }
  }
  // Group the candidates by the run that produced them, keeping chronological order.
  const bySession = new Map();
  for (const c of candidates) {
    const k = c.session || '(none)';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(c);
  }
  let bestSession = null;
  for (const [, turns] of bySession) {
    turns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const acted = turns.some((t) => t.calls && t.calls.length);
    const answered = turns.some((t) => t.parsed);
    // A session that ACTED and then ANSWERED is a completed piece of work. Prefer it, then the
    // longest session — a one-turn session is usually an attempt that gave up.
    const score = (acted ? 4 : 0) + (answered ? 2 : 0) + Math.min(turns.length, 2) / 2;
    if (!bestSession || score > bestSession.score
        || (score === bestSession.score && turns.length > bestSession.turns.length)) {
      bestSession = { turns, score };
    }
  }
  if (bestSession && bestSession.turns.length > 1) {
    const turns = bestSession.turns;
    return { turns, multi: true,
      file: `langfuse:session ${turns[0].session || '?'} (${turns.length} turns, `
        + `${turns.reduce((n, t) => n + ((t.calls || []).length), 0)} tool call(s))`,
      body: turns[turns.length - 1].body,
      parsed: !!turns[turns.length - 1].parsed,
      calls: [] };
  }

  if (!candidates.length) return null;
  // A SEAM THAT ACTS NEEDS THE CALL IT MADE, not the sentence it wrote afterwards.
  // roster-specialiser and the writer deliver by TOOL CALL; a text reply from the same seam is a
  // narration of work that never happened here. Prefer a capture that carries tool calls, then the
  // most substantial one — a 100-byte answer is almost always a failed attempt.
  // RANK BY FITNESS FOR THE CONTRACT, NOT BY SIZE.
  //
  // Sorting by length alone picked a 253-byte narration — "Now I have all the evidence I need..." —
  // over the shorter JSON answer, and codeline-discovery died on "No JSON in LLM response". A reply
  // that PARSES is the one its consumer can use; a reply that made TOOL CALLS is the one a seam
  // that acts (roster-specialiser, the writer) actually delivered through. Length only breaks ties.
  const fitness = (c) => (c.parsed ? 2 : 0) + (c.toolCalls > 0 ? 1 : 0);
  candidates.sort((a, b) => (fitness(b) - fitness(a))
    || (b.toolCalls - a.toolCalls) || (b.len - a.len));
  const best = candidates[0];
  return { body: best.body, file: best.file + (best.toolCalls ? ` (${best.toolCalls} tool call(s))` : ''),
    parsed: !!best.parsed, calls: best.calls || [] };
}

function cassetteReply(seam) {
  const root = path.join(ROOT, 'orchestrations/cassettes');
  if (!fs.existsSync(root)) return null;
  const unesc = (n) => n.replace(/~00([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const runs = fs.readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    .sort().reverse();
  for (const run of runs) {
    let files = [];
    try { files = fs.readdirSync(run); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      // The seam is the leading segment: "spec-agent · MOCK3-2.json" -> "spec-agent".
      const name = unesc(f.replace(/\.json$/, '')).split(/[:·]/)[0].trim();
      if (name !== seam) continue;
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(run, f), 'utf8')); } catch { continue; }
      // Turns are indexed; the last one carries the answer the pipeline consumed.
      const turns = Object.keys(doc).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b);
      for (const k of turns.reverse()) {
        const text = doc[k] && (doc[k].text || doc[k].content);
        if (typeof text === 'string' && text.trim()) {
          let parsed = null;
          try { parsed = JSON.parse(text.trim()); } catch { /* prose is still a real reply */ }
          return { body: text.trim(), file: `cassette:${path.basename(run)}/${f}`, parsed: !!parsed };
        }
      }
    }
  }
  return null;
}

function capturedReply(seam) {
  if (!fs.existsSync(ARCHIVE_ROOT)) return null;
  const dirs = fs.readdirSync(ARCHIVE_ROOT)
    .map((d) => path.join(ARCHIVE_ROOT, d))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    .sort().reverse();
  const wanted = new RegExp(`^${seam.replace(/[^a-z0-9]/gi, '.')}.*\\.log$`, 'i');
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files.filter((x) => wanted.test(x))) {
      let t = '';
      try { t = fs.readFileSync(path.join(d, f), 'utf8'); } catch { continue; }
      const i = t.indexOf('# Output');
      const body = (i >= 0 ? t.slice(i + 8).replace(/^[^\n]*\n/, '') : t).trim();
      if (!body) continue;
      // Never replay a replay: a mocked run's captures are not evidence of anything.
      if (/"model"\s*:\s*"replay"/.test(t)) continue;
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* prose replies are still real replies */ }
      return { body, file: path.join(path.basename(d), f), parsed: !!parsed };
    }
  }
  return null;
}

/** OpenAI streaming framing — the CLI requests stream:true, so a plain body yields no output. */
function sse(content) {
  const chunk = (delta) => `data: ${JSON.stringify({
    id: 'replay',
    object: 'chat.completion.chunk',
    model: 'replay',
    choices: [{ index: 0, delta, finish_reason: delta.content === undefined ? 'stop' : null }],
  })}\n\n`;
  return chunk({ role: 'assistant', content }) + chunk({}) + 'data: [DONE]\n\n';
}

/**
 * A TOOL-CALL TURN, in the streaming shape the client expects.
 *
 * A seam that ACTS delivers through a call, not a sentence. Replaying only its text leaves the work
 * undone — roster-specialiser's roster never appears and its contract refuses, three attempts in a
 * row. Recorded calls are re-emitted here so the client executes them for real: the file gets
 * written by the same bash the model originally ran.
 */
function sseToolCalls(calls) {
  const chunk = (delta, finish) => `data: ${JSON.stringify({
    id: 'replay', object: 'chat.completion.chunk', model: 'replay',
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  })}\n\n`;
  const tool_calls = calls.map((c, i) => ({
    index: i,
    id: `call_replay_${i}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
  }));
  return chunk({ role: 'assistant', content: '', tool_calls })
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
}

function put(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(HOST + urlPath);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT',
      headers: { 'content-type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

(async () => {
  await put('/mockserver/reset');
  const all = seams();
  const covered = [];
  const uncovered = [];
  const seen = new Set();

  for (const { seam, template } of all) {
    const key = matchKey(template);
    if (!key) { uncovered.push(`${seam} (no template body)`); continue; }
    if (seen.has(key)) continue;           // two seams sharing a template share an answer
    const cap = (await langfuseReply(seam)) || cassetteReply(seam) || capturedReply(seam);
    if (!cap) { uncovered.push(`${seam} (no captured reply)`); continue; }
    seen.add(key);
    const match = { method: 'POST', path: '/api/v1/chat/completions',
      body: { type: 'STRING', string: key, subString: true } };

    if (cap.multi) {
      // ONE EXPECTATION PER TURN, each consumed once, so the conversation replays in the order it
      // actually happened: reads first, the write where it really occurred, the answer last.
      for (const turn of cap.turns) {
        const body = (turn.calls && turn.calls.length)
          ? sseToolCalls(turn.calls) : sse(turn.body);
        await put('/mockserver/expectation', {
          priority: 40, times: { remainingTimes: 1, unlimited: false },
          httpRequest: match,
          httpResponse: { statusCode: 200,
            headers: { 'content-type': ['text/event-stream'] }, body },
        });
      }
    } else if (cap.calls && cap.calls.length) {
      // TURN ONE: the calls, consumed once. MockServer serves expectations for the same matcher in
      // order, so the client executes the tools, comes back, and gets the answer below.
      await put('/mockserver/expectation', {
        priority: 40, times: { remainingTimes: 1, unlimited: false },
        httpRequest: match,
        httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'] },
          body: sseToolCalls(cap.calls) },
      });
    }
    // TURN TWO (or the only turn): what the model said once its work was done.
    await put('/mockserver/expectation', {
      priority: 30,
      httpRequest: match,
      httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'] },
        body: sse(cap.body) },
    });
    covered.push(`${seam}  <- ${cap.file}${cap.parsed ? '' : ' (prose)'}`);
  }

  // A catch-all so an unmatched seam is visibly empty rather than reaching the network.
  await put('/mockserver/expectation', {
    priority: 1,
    httpRequest: { method: 'POST', path: '/api/v1/.*' },
    httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'] },
      body: sse('{}') },
  });

  console.log(`covered ${covered.length} seam(s) from real captures:`);
  covered.forEach((c) => console.log(`  ${c}`));
  console.log(`\nUNCOVERED ${uncovered.length} — these answer {} and will fail their contract:`);
  uncovered.slice(0, 20).forEach((u) => console.log(`  ${u}`));
})().catch((e) => { console.error(e.message); process.exit(1); });
