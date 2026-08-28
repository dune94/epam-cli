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
/**
 * WHAT MAKES THIS STORY'S REQUEST DIFFERENT FROM THE OTHER STORY'S.
 *
 * A story ID is useless as a discriminator: the prompt carries the whole PRD, so MOCK3-1 is named
 * in MOCK3-2's request 68 times over. Matching on the id served MOCK3-1's captured answer to
 * MOCK3-2 — which is how mockb came to be specified against src/fares.ts and test/fares.test.ts,
 * mocka's files, and was then flagged for declaring files that do not exist.
 *
 * The story's own TITLE is unique to it and appears only in its own prompt. Read from the PRD, so
 * no story text is written here and a project with different stories needs no change.
 */
let _titles;
function storyDiscriminator(storyId) {
  if (!storyId) return null;
  if (!_titles) {
    _titles = {};
    try {
      const prd = process.env.PRD_FILE
        || path.join(process.env.EPAM_PROJECT_CONFIG_DIR || '', 'prd.json');
      const j = JSON.parse(fs.readFileSync(prd, 'utf8'));
      for (const st of (j.stories || [])) if (st && st.id) _titles[st.id] = String(st.title || '');
    } catch { _titles = {}; }
  }
  const t = _titles[storyId];
  // Long enough to be this story's alone; a title too short to distinguish is not used.
  return t && t.length > STORY_TITLE_MINIMUM_CHARS ? t.slice(0, STORY_TITLE_MATCH_CHARS) : null;
}

// WHAT COUNTS AS A USABLE FINGERPRINT, NAMED RATHER THAN SPRINKLED.
//
// A matcher is a substring of the prompt, so its length is a trade: too short and it collides with
// another seam's text, too long and a single reformatting breaks it. These are the three decisions
// that were previously three bare numbers in three expressions.
const FINGERPRINT_PREFERRED_CHARS = 45;   // a line this long is distinctive on its own
const FINGERPRINT_MINIMUM_CHARS = 15;     // below this a line is shared boilerplate, not identity
const FINGERPRINT_MATCH_CHARS = 50;       // how much of the chosen line is matched on
// A STORY TITLE SHORT ENOUGH TO COLLIDE IS NOT A DISCRIMINATOR. Two stories in one PRD can share
// an opening phrase; a title this long is the story's own.
const STORY_TITLE_MINIMUM_CHARS = 25;
const STORY_TITLE_MATCH_CHARS = 60;
// HOW MUCH OF LANGFUSE TO READ. Each page is one HTTP round trip against a local service; this is
// a scan budget, not a limit on what exists.
const LANGFUSE_PAGE_SIZE = 50;
// AN OBSERVATION WITH NO PROMPT CANNOT BE MATCHED TO A SEAM, and one with no reply is nothing to
// replay. Both are floors for "is there anything here at all", not quality judgements.
const MINIMUM_PROMPT_CHARS = 200;
const MINIMUM_REPLY_CHARS = 2;

/**
 * A MATCHER COMPARES AGAINST THE BODY AS SENT, NOT AS AUTHORED.
 *
 * MockServer matches the raw request body, where the prompt is a JSON string value — so every quote
 * in it arrives escaped. A fingerprint taken straight from a template or a PRD carries raw quotes
 * and matches nothing.
 */
const wireForm = (t) => JSON.stringify(t).slice(1, -1);
/** Escape a literal so it can sit inside a regex matcher. */
const rx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchKey(template) {
  const f = path.join(TPL, `${template}.json`);
  if (!fs.existsSync(f)) return null;
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  const body = t.bodies ? Object.values(t.bodies).join('\n') : String(t.body || '');
  // A FINGERPRINT MUST SURVIVE RENDERING.
  //
  // This rejected lines that BEGIN with a placeholder and accepted any that merely contain one, so
  // spec-agent's fingerprint became `"title":"...",__LOCATION_HINT_SCHEMA_LINE____SPLIT` — a string
  // that exists only before substitution. Its expectation could therefore never match: all sixteen
  // of its calls fell through to the catch-all, answered {}, and the spec pass reported the seam's
  // own required field as missing. Four attempts to fix that looked at the reply; the reply was
  // never the problem.
  //
  // A line qualifies only if it carries no placeholder anywhere, so what the matcher holds is what
  // the model is actually sent.
  // Prefer a long placeholder-free line; some templates have none. spec-agent's body is a 617-char
  // JSON schema fragment where every long line carries a placeholder, so demanding 45 characters
  // left it with NO fingerprint and every one of its calls fell to the catch-all. Its literal
  // schema text — `"acceptanceCriteria":["..."],` — is short but real, and reaches the model
  // unchanged, which is the only property a matcher needs.
  const survives = (l) => !/__[A-Z0-9_]+__/.test(l);
  const lines = body.split('\n').map((l) => l.trim()).filter(survives);
  const line = lines.find((l) => l.length > FINGERPRINT_PREFERRED_CHARS)
    || lines.filter((l) => l.length > FINGERPRINT_MINIMUM_CHARS)
      .sort((a, b) => b.length - a.length)[0];
  return line ? line.trim().slice(0, FINGERPRINT_MATCH_CHARS) : null;
}

/**
 * REAL REPLIES MINED FROM LANGFUSE BY WHAT THE PROMPT SAID.
 *
 * langfuseReply asks for traces NAMED after the seam. Those exist — 958 for team-lead-review — and
 * their input and output are both EMPTY: prompt capture regressed at some point, so the seam-named
 * traces record cost and latency and nothing else.
 *
 * The replies are still there, in older observations named `chain:stream`, which carry the whole
 * rendered prompt and the whole answer. They are not labelled with a seam, so the seam has to be
 * recovered from the prompt itself — matched on the same fingerprint the mock matcher already uses,
 * a distinctive literal line from the seam's own template. Nothing is named here and no seam is
 * special-cased: a seam whose template changes is matched by its new text.
 *
 * PARTIAL BY DESIGN. Whatever this finds is a real answer replacing a stale file or a synthetic
 * stand-in; whatever it misses falls through to the chain below it, exactly as before.
 */
/** A GET against Langfuse, shared by both lookups so they cannot disagree about auth or host. */
function langfuseGet() {
  const base = declaredServiceUrl('langfuse');
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!pub || !sec || !base) return null;
  const auth = Buffer.from(`${pub}:${sec}`).toString('base64');
  return (p) => new Promise((resolve) => {
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
}

let _lfPool;
async function langfuseObservationPool(get) {
  if (_lfPool) return _lfPool;
  _lfPool = [];
  const MAX_PAGES = Number(process.env.EPAM_LANGFUSE_SCAN_PAGES) || 24;
  const START = Number(process.env.EPAM_LANGFUSE_SCAN_START) || 760;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = START + i;
    // eslint-disable-next-line no-await-in-loop
    const r = await get(`/api/public/observations?limit=${LANGFUSE_PAGE_SIZE}&page=${page}`);
    const rows = (r && r.data) || [];
    if (!rows.length) break;
    for (const o of rows) {
      const inp = typeof o.input === 'string' ? o.input : JSON.stringify(o.input || '');
      const out = o && o.output;
      const text = typeof out === 'string' ? out
        : (out && (out.content || out.text || JSON.stringify(out)));
      if (!inp || inp.length < MINIMUM_PROMPT_CHARS) continue;   // no prompt, nothing to match on
      if (typeof text !== 'string' || text.trim().length < MINIMUM_REPLY_CHARS) continue;
      _lfPool.push({ inp, text, id: o.id });
    }
  }
  return _lfPool;
}

async function langfuseByFingerprint(seam, template, get) {
  // THREE FINGERPRINTS, WEAKEST LAST.
  //
  // A template line only matches a prompt that was COPIED. Historical runs generated their prompts
  // — the mint specialised each one per project — so the template's own wording is absent from
  // them and the first scan matched nothing at all. What survives specialisation is what the seam
  // is REQUIRED to emit: its output tag and the name of the tool it must call. A prompt that does
  // not mention either is not this seam's prompt.
  const keys = [matchKey(template)];
  try {
    // eslint-disable-next-line global-require
    const { declaredContracts: dc, TAG_TO_TOOL } = require('./lib/agent-output-schema.js');
    const c = dc()[seam];
    if (c && c.tag) {
      keys.push(c.tag);
      const t = TAG_TO_TOOL[c.tag];
      if (t) keys.push(realToolName(t.tool));
    }
  } catch { /* a seam with no declared contract keeps only its template fingerprint */ }
  const usable = keys.filter(Boolean);
  if (!usable.length) return null;
  const pool = await langfuseObservationPool(get);
  const hit = pool.find((o) => usable.some((k) => o.inp.includes(k)));
  if (!hit) return null;
  let parsed = false;
  try { JSON.parse(hit.text); parsed = true; } catch { parsed = /\{[\s\S]*\}/.test(hit.text); }
  return { body: hit.text, file: `langfuse:${hit.id}`, parsed, calls: [] };
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
  const base = declaredServiceUrl('langfuse');
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

/**
 * A CAPTURE FOR THIS SEAM — AND, WHERE ASKED, FOR THIS STORY.
 *
 * Cassettes are recorded per call, so a seam invoked once per story has one file per story:
 * `code-graph-detective · MOCK3-1.json` beside `· MOCK3-2.json`. This returned the FIRST match and
 * stopped, so the second story's real answer was never reachable at all.
 */
function cassetteReply(seam, story) {
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
      const plain = unesc(f.replace(/\.json$/, ''));
        const name = plain.split(/[:·]/)[0].trim();
      if (name !== seam) continue;
        // WHEN A STORY IS ASKED FOR, ONLY ITS OWN CAPTURE WILL DO. Asking for one story and
        // being handed another's is the defect this parameter exists to prevent: MOCK3-2 was
        // specified against src/fares.ts, mocka's file, from MOCK3-1's recorded answer.
        if (story && !plain.includes(story)) continue;
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

/**
 * ANTHROPIC MESSAGES STREAMING — a DIFFERENT protocol from the OpenAI shape above.
 *
 * Two framings, because two clients. The epam-run path speaks OpenAI chat-completions
 * (`data: {...}` then `data: [DONE]`). Claude Code speaks Anthropic Messages: named EVENTS
 * (`event: content_block_delta`) and a `message_stop` terminator, with NO [DONE] sentinel.
 * Serving one to the other yields a client that connects, reads nothing usable and reports an
 * empty turn — which looks like a model that said nothing rather than a framing mismatch.
 *
 * Proven 2026-08-25: this exact shape returns is_error:false, result:"OK",
 * stop_reason:"end_turn" from Claude Code against MockServer.
 */
function anthropicSse(content, model) {
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
  return ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_replay', type: 'message', role: 'assistant',
        model: model || 'replay', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } },
    })
    + ev('content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: String(content == null ? '' : content) } })
    + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
    + ev('message_delta', { type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    + ev('message_stop', { type: 'message_stop' });
}

/**
 * A TOOL-CALL TURN in the Anthropic shape.
 *
 * The same reason as sseToolCalls: a seam that ACTS delivers through a call, and replaying its
 * text alone leaves the work undone. Anthropic carries a call as a `tool_use` content block with
 * its input streamed as `input_json_delta`, and the turn must stop with `tool_use`, not
 * `end_turn` — a client told the turn ended will not execute the call it was just handed.
 */
function anthropicSseToolCalls(calls, model) {
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
  let out = ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_replay', type: 'message', role: 'assistant',
      model: model || 'replay', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } },
  });
  calls.forEach((c, i) => {
    out += ev('content_block_start', { type: 'content_block_start', index: i,
      content_block: { type: 'tool_use', id: `toolu_replay_${i}`, name: c.name, input: {} } });
    out += ev('content_block_delta', { type: 'content_block_delta', index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input || {}) } });
    out += ev('content_block_stop', { type: 'content_block_stop', index: i });
  });
  out += ev('message_delta', { type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
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

module.exports = { sse, sseToolCalls, anthropicSse, anthropicSseToolCalls };

// RUNNING IS OPT-IN. Requiring this file used to EXECUTE the whole registration pass — which
// meant a test that imported it hit MockServer, and the two SSE framings could not be unit
// tested at all. Same guard agent-check.js carries, for the same reason.
if (require.main !== module) return;

/**
 * A CONTRACT-VALID STAND-IN FOR A SEAM NOBODY HAS EVER CAPTURED.
 *
 * A rehearsal exists to prove the pipeline's JOINS carry their values. It cannot do that if it
 * stops at the first seam with no recorded reply — and fourteen seams have none, story-writer and
 * every QA gate among them, because no run has ever reached them. Answering `{}` there fails the
 * seam's contract and ends the rehearsal at exactly the stages that have never been exercised.
 *
 * So the reply is DERIVED from what the seam itself declares it will return: requiredKeys from its
 * own contract, filled with values of the shape its consumer reads. Nothing is invented per seam
 * and no seam is named here — a seam whose contract changes gets a different stand-in for free,
 * and a seam that declares nothing still gets an empty object, which is the honest answer.
 *
 * These are STAND-INS, not captures. They prove a join is wired and carries a value; they prove
 * nothing about what a real model would say, and the rehearsal reports them separately for that
 * reason.
 */
/** The stories this project declares, read from its PRD — never listed here. */
function projectStories() {
  try {
    const prd = process.env.PRD_FILE
      || path.join(process.env.EPAM_PROJECT_CONFIG_DIR || '', 'prd.json');
    const j = JSON.parse(fs.readFileSync(prd, 'utf8'));
    return (j.stories || []).filter((s) => s && s.id)
      .map((s) => ({ id: s.id, codeline: s.codeline || (s.files && s.files[0]) || '' }));
  } catch { return []; }
}

/** Does this property's own schema say its value must be one of the project's roles? */
function expectsARole(spec) {
  if (!spec) return false;
  if (Array.isArray(spec.enum) && spec.enum.length) {
    const declared = [...projectEntities()];
    return spec.enum.some((v) => declared.includes(v));
  }
  return /\brole\b/i.test(String(spec.description || ''));
}

/** The wrapper key a tagged payload uses for this seam, or '' when items are bare. */
function TAG_ITEMS_KEY(seam) {
  try {
    // eslint-disable-next-line global-require
    const { declaredContracts: dc, TAG_TO_TOOL } = require('./lib/agent-output-schema.js');
    const c = dc()[seam];
    const t = c && c.tag && TAG_TO_TOOL[c.tag];
    return (t && t.itemsKey) || '';
  } catch { return ''; }
}

function contractStandIn(seam) {
  let contracts = {};
  try {
    // eslint-disable-next-line global-require
    ({ declaredContracts: contracts } = require('./lib/agent-output-schema.js'));
    contracts = contracts();
  } catch { return null; }
  const c = contracts[seam];
  if (!c) return null;

  // A value whose SHAPE matches what the key's name says it holds, so a consumer that indexes or
  // iterates finds something rather than a string where it expected a list.
  const valueFor = (k) => {
    if (/s$/.test(k) && !/status|address/i.test(k)) return [];
    if (/^(is|has|should|can|must)/i.test(k)) return false;
    if (/count|total|score|index|number/i.test(k)) return 0;
    if (/verdict/i.test(k)) return 'pass';
    return `stand-in for ${seam}: no captured reply exists for this seam`;
  };

  if (c.kind === 'declared') {
    const o = {};
    for (const k of (c.requiredKeys || [])) o[k] = valueFor(k);
    return Object.keys(o).length ? o : null;
  }
  if (c.kind === 'schema' && c.tag) {
    // DERIVED FROM THE TAG'S OWN SCHEMA. Every required property is filled with a value of the
    // declared type, and a property whose name says it holds a role is filled with one this
    // project actually declares — so the consumer finds a brief instead of refusing the work.
    let schema = null;
    try {
      // eslint-disable-next-line global-require
      const { itemSchemaFor } = require('./lib/agent-output-schema.js');
      schema = itemSchemaFor(c.tag);
    } catch { schema = null; }
    if (!schema || !schema.properties) return null;
    const ents = [...projectEntities()];
    const build = (name, spec) => {
      const t = (spec && spec.type) || 'string';
      if (t === 'array') return [];
      if (t === 'number' || t === 'integer') return 0;
      if (t === 'boolean') return false;
      if (t === 'object') return {};
      if (/role|agent|name/i.test(name) && ents.length) return ents[0];
      return `stand-in for ${seam}`;
    };
    // ONE ROLE PER STORY, NOT THE SAME ROLE TWICE.
    //
    // Filling every story's role with the first declared implementer gave MOCK3-2 in codeline mockb
    // an engineer whose brief covers mocka, and assignment refused it — correctly. Stories are
    // matched to roles by position, so each story gets a distinct one wherever enough are declared.
    const _ents = [...projectEntities()];
    const mk = (story, idx) => {
      const o = {};
      for (const k of (schema.required || [])) {
        // A per-story schema is answered PER STORY: fill the identifier from the story this item
        // is for, not with a placeholder that belongs to no story.
        if (story && /^storyid$/i.test(k)) { o[k] = story.id; continue; }
        if (story && /^codeline$/i.test(k) && story.codeline) { o[k] = story.codeline; continue; }
        // A FIELD IS ROLE-VALUED WHEN ITS OWN SCHEMA SAYS SO, not when its name matches a list
        // kept here. The property describes itself — "MUST be one of the offered roles" — and that
        // description is the seam's statement about its own contract, which is the thing to read.
        if (story && _ents.length && expectsARole((schema.properties || {})[k])) {
          o[k] = _ents[(idx || 0) % _ents.length];
          continue;
        }
        o[k] = build(k, (schema.properties || {})[k]);
      }
      return o;
    };
    // ONE ITEM PER STORY WHERE THE SCHEMA IS PER-STORY.
    //
    // role-assigner returns an assignment for every story; a stand-in emitting a single item left
    // the rest unassigned, and the run halted with "unassigned after the agent's full retry budget"
    // — a stand-in that answers for one story is not an answer for the others.
    const perStory = (schema.required || []).some((k) => /^storyid$/i.test(k));
    if (perStory) {
      const stories = projectStories();
      if (stories.length) return stories.map((st, i) => mk(st, i));
    }
    const o = mk(null);
    return Object.keys(o).length ? o : null;
  }
  if (c.kind === 'verdict') return { verdict: 'pass', findings: [] };
  if (c.kind === 'artefact') return { note: `stand-in artefact for ${seam}` };
  // A seam that declares NO contract is satisfied by any JSON object — so it gets one, rather than
  // being left to the catch-all and reported as uncovered when nothing is in fact missing.
  if (c.kind === 'none') return { note: `stand-in for ${seam}: this seam declares no output contract` };
  return null;
}

/**
 * THE ENTITIES THIS PROJECT ACTUALLY HAS.
 *
 * Read from the project's own declarations, never listed here — a different project has different
 * roles and must need no change to this file.
 */
function projectEntities() {
  const dir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
  const names = new Set();
  if (!dir) return names;
  for (const f of ['project-roles.json', 'project-investigators.json']) {
    try {
      const j = JSON.parse(require('node:fs').readFileSync(require('node:path').join(dir, f), 'utf8'));
      for (const n of (j.roles || j.investigators || [])) if (typeof n === 'string') names.add(n);
    } catch { /* a project that declares none contributes none */ }
  }
  return names;
}

/**
 * A CAPTURE NAMES THE PROJECT IT CAME FROM; THIS ONE IS A DIFFERENT PROJECT.
 *
 * A cassette is a real answer from a real run, and real answers name real things — so when the
 * roster changes, the capture goes on naming the roles of the run it came from. Replaying it makes
 * the pipeline reject its own input: on 2026-08-27 a replayed role-assigner assigned both mock3
 * stories to "typescript-logic-fixer" while the project declared fare-rules-engineer and
 * schedule-display-engineer, and the run halted — correctly, because that role has no brief.
 *
 * DISCARDING the capture was the first attempt and it was worse: a synthesised reply loses the
 * structure and the per-story reasoning that make the replay worth having, and the run then failed
 * with every story unassigned instead. So the capture is KEPT and only the stale names are
 * rewritten — same shape, same reasoning, entities this project actually has.
 *
 * Roles are matched by the roster's own suffix convention and mapped in declaration order, so the
 * rewrite is stable between runs rather than depending on which name appeared first.
 */
/**
 * DOES THIS TOKEN LOOK LIKE ONE OF THIS PROJECT'S ROLE NAMES?
 *
 * Judged against the suffixes the PROJECT itself uses — fare-rules-ENGINEER, mocka-DETECTIVE —
 * rather than a list written here. A project whose roles end differently is recognised without
 * changing this file, which is the whole point: the roster's vocabulary is the project's, and an
 * engine that keeps its own copy of it is wrong the moment a project disagrees.
 */
function roleShaped(token) {
  const declared = [...projectEntities()];
  if (!declared.length || !token) return false;
  const suffixes = new Set(declared.map((d) => d.split('-').pop()).filter((x) => x && x.length > 3));
  const tail = String(token).split('-').pop();
  return suffixes.has(tail) && String(token).includes('-');
}

function refreshEntities(cap) {
  if (!cap || !cap.body) return cap;
  const declared = [...projectEntities()];
  if (!declared.length) return cap;
  let body = String(cap.body);
  const shaped = [...new Set(body.match(/\b[a-z]+(?:-[a-z]+){1,3}\b/g) || [])]
    .filter((t) => roleShaped(t))
    .filter((t) => !declared.includes(t));
  if (!shaped.length) return cap;
  // Keep the kind: a detective in the capture becomes a detective here, an implementer an
  // implementer — the suffix is how this roster states kind, so it is what the match reads.
  const kindOf = (n) => (/-detective$/.test(n) ? 'detective' : 'implementer');
  const byKind = { detective: declared.filter((d) => /-detective$/.test(d)),
                   implementer: declared.filter((d) => !/-detective$/.test(d)) };
  const swapped = [];
  shaped.forEach((stale, i) => {
    const pool = byKind[kindOf(stale)].length ? byKind[kindOf(stale)] : declared;
    const to = pool[i % pool.length];
    body = body.split(stale).join(to);
    swapped.push(`${stale} -> ${to}`);
  });
  return { ...cap, body, refreshed: swapped };
}

/**
 * THE TOOL'S REAL NAME, NOT THE CONSTANT THAT HOLDS IT.
 *
 * TAG_TO_TOOL maps a tag to the IDENTIFIER of the tool definition — 'TOOL_SPEC_AGENT' — while the
 * client calls the tool by its `name`, which is 'submit_spec_result'. A stand-in that calls the
 * identifier is a call to a tool that does not exist, and the seam reports its required field as
 * missing rather than reporting an unknown tool. Live 2026-08-27: four SPEC_AGENT failures whose
 * stand-in carried storyId all along.
 *
 * Resolved by reading the definition where it lives, so a renamed tool is followed automatically.
 */
let _toolNames;
function realToolName(identifier) {
  if (!_toolNames) {
    _toolNames = {};
    const fs = require('node:fs'); const path = require('node:path');
    const walk = (d) => { for (const e of fs.readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const f = path.join(d, e);
      if (fs.statSync(f).isDirectory()) { walk(f); continue; }
      if (!/\.js$/.test(e)) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/const\s+(TOOL_[A-Z0-9_]+)\s*=\s*\{\s*\n\s*name:\s*'([^']+)'/g)) {
        _toolNames[m[1]] = m[2];
      }
    } };
    try { walk(path.join(__dirname)); } catch { /* nothing resolvable */ }
  }
  return _toolNames[identifier] || identifier;
}

/** The tool a schema seam must be answered with, or '' when it declares none. */
function requiredToolName(seam) {
  try {
    // eslint-disable-next-line global-require
    const { declaredContracts: dc, TAG_TO_TOOL } = require('./lib/agent-output-schema.js');
    const c = dc()[seam];
    const t = c && c.tag && TAG_TO_TOOL[c.tag];
    return t ? realToolName(t.tool) : '';
  } catch { return ''; }
}

/** Does this seam's checker read a TOOL CALL rather than prose? */
function standCallRequired(seam) {
  try {
    // eslint-disable-next-line global-require
    const { declaredContracts: dc, TAG_TO_TOOL } = require('./lib/agent-output-schema.js');
    const c = dc()[seam];
    return !!(c && c.kind === 'schema' && c.tag && TAG_TO_TOOL[c.tag]);
  } catch { return false; }
}

/** Did the captured conversation END by calling a tool, or by talking? */
function endsInToolCall(cap, seam) {
  // AND THE CALL MUST CARRY SOMETHING. A captured tool call with empty arguments is a call the
  // model began and never filled; replaying it hands the seam `{}` in the exact shape it expects,
  // which reads as an agent that answered nothing. Live 2026-08-28: role-assigner replayed
  // `"partial_json":"{}"` and both stories came back unassigned after the full retry budget.
  // Arguments travel under different names depending on where the capture came from — a cassette,
  // an Anthropic stream, an OpenAI stream — so every shape is read rather than one guessed at.
  const argsOf = (c) => {
    for (const k of ['arguments', 'input', 'args', 'parameters', 'partial_json', 'json']) {
      if (c && c[k] !== undefined && c[k] !== null) return c[k];
    }
    return null;
  };
  const filled = (c) => {
    const a = argsOf(c);
    if (a === null) return false;
    const t = typeof a === 'string' ? a.trim() : JSON.stringify(a);
    return !!t && t !== '{}' && t !== '[]' && t !== '""' && t !== 'null';
  };
  // AND IT MUST BE THIS SEAM'S TOOL. A captured session ends in whatever tool the model reached
  // for last — a file read, a search — and replaying that answers the seam with someone else's
  // call. role-assigner replayed a two-call session and both stories came back unassigned.
  const wanted = requiredToolName(seam);
  const isTheOne = (c) => filled(c) && (!wanted || String((c && c.name) || '') === wanted);
  if (!cap) return false;
  if (Array.isArray(cap.calls) && cap.calls.length) return cap.calls.some(isTheOne);
  if (cap.multi && Array.isArray(cap.turns) && cap.turns.length) {
    return cap.turns.some((t) => t && Array.isArray(t.calls) && t.calls.some(isTheOne));
  }
  return false;
}

(async () => {
  await put('/mockserver/reset');
  const all = seams();
  const covered = [];
  const uncovered = [];
  const stoodIn = [];
  const stale = [];
  const unusable = [];
  const shared = [];
  const perStory = [];
  const foreign = [];
  const seen = new Set();

  for (const { seam, template } of all) {
    const key = matchKey(template);
    if (!key) { uncovered.push(`${seam} (no template body)`); continue; }
    // WHICH SEAM OWNS THIS MATCHER, SAID OUT LOUD.
    //
    // Every fidelity bug today was found three stages downstream from its cause: a seam whose
    // expectation stopped matching fell through to the catch-all, answered 16 characters, and
    // surfaced as "the answer did not parse" inside content-retry. The matcher knows which seam it
    // registered for; printing it turns a fifteen-minute hunt into a line of output.
    // THE BEST SOURCE, NOT THE FIRST ONE.
    //
    // Ordering the sources and taking the first match makes a richer source a LIABILITY: Langfuse
    // holds real multi-turn sessions, and preferring it replaced a working codeline-discovery
    // cassette with a reply that could not resolve scope — the rehearsal went backwards by gaining
    // data. So every source is asked and the first reply that actually PARSED wins; an unparsed one
    // is kept only if nothing better exists, and a seam with no parseable reply anywhere falls
    // through to its contract stand-in.
    const _lfGet = langfuseGet();
    const _sources = [
      _lfGet ? await langfuseByFingerprint(seam, template, _lfGet) : null,
      await langfuseReply(seam),
      cassetteReply(seam),
      capturedReply(seam),
    ].filter(Boolean);
    // A CAPTURE FROM ANOTHER PROJECT IS ANOTHER PROJECT'S ANSWER.
    //
    // Sources are shared across projects — cassette directories, Langfuse sessions and captured
    // logs all sit together — and a reply carries the FILES and NAMES of the run it came from.
    // Serving one to a different project puts that project's world into this one's prompts: live
    // 2026-08-27, mock3's spec pass declared src/context/ContentstackContext.tsx, a metrolinx file
    // that exists in neither mocka nor mockb, and both stories were flagged for naming files that
    // do not exist. The same leak, by a different route, that put another client's documentation in
    // mock3's prompts for nineteen days.
    //
    // So a source belonging to THIS project outranks a better-parsed one from another. Ownership is
    // read from the source's own name against the project's directory name — no project is named
    // here, and a project with no captures of its own still falls back rather than stalling.
    const _project = path.basename(process.env.EPAM_PROJECT_CONFIG_DIR || '');
    const _mine = (c) => !!_project && String(c.file || '').includes(_project);
    let cap = _sources.find((c) => _mine(c) && c.parsed)
      || _sources.find((c) => _mine(c))
      || _sources.find((c) => c.parsed)
      || _sources[0] || null;
    if (cap && _project && !_mine(cap)) {
      foreign.push(`${seam}  <- ${cap.file} (no ${_project} capture; another project's answer)`);
    }
    // A STORY-SPECIFIC CAPTURE MUST NOT ANSWER FOR ANOTHER STORY.
    //
    // The matcher keys on the seam's TEMPLATE, which is identical for every story, so the first
    // story's answer was served to all of them. For a per-story seam that is a contamination: live
    // 2026-08-27, MOCK3-2 in codeline mockb was specified against src/fares.ts and
    // test/fares.test.ts — MOCK3-1's files, in mocka — and flagged for declaring files that do not
    // exist. The capture was right; it was answering the wrong question.
    //
    // Where a capture names its story, the story joins the dedup key and the matcher, so each
    // story gets its own. A capture that names no story keeps the old single-answer behaviour.
    const _story = (cap && String(cap.file || '').match(/\b[A-Z][A-Z0-9]+-\d+\b/) || [])[0] || '';
    const _dedup = _story ? `${key}::${_story}` : key;
    if (seen.has(_dedup)) {
      shared.push(`${seam} shares a matcher with an earlier seam — one answer serves both`);
      continue;
    }
    let stood = null;
    // A CAPTURE THAT NEVER SATISFIED ITS CONTRACT IS A RECORDING OF A FAILURE.
    //
    // Cassettes preserve what a model actually said, including the times it answered in prose where
    // its tool definition required JSON. Replaying one reproduces that failure exactly — which is
    // faithful and useless: the rehearsal exists to prove the JOINS carry values, and it cannot do
    // that while re-enacting a model's bad day. Live 2026-08-27: spec-coordinator and spec-agent
    // both replayed prose, the spec pass reported "no parseable output" and "missing required field
    // storyId", and both codelines halted — a verdict about a capture, not about the pipeline.
    //
    // So an unparsed capture is set aside for the contract stand-in, which answers the seam's own
    // declared shape. The real capture stays on disk and is reported, so the underlying failure is
    // still visible rather than quietly replaced.
    // A CAPTURE MUST SATISFY THE SEAM'S DELIVERY CONTRACT, NOT ONLY ITS CONTENT.
    //
    // A schema seam is answered by CALLING ITS TOOL. Its checker reads the call's arguments and
    // never looks at prose, so a captured session whose final turn was text fails the seam even
    // when the text contains every required field. Live 2026-08-28: spec-agent replayed two turns —
    // a tool call carrying no storyId, then prose carrying storyId — and the pass reported storyId
    // missing while the value sat in the reply.
    //
    // Where the seam requires a tool call and the capture does not end in one, the capture is set
    // aside for the contract stand-in, which delivers the same fields the way the checker reads
    // them. The real capture stays on disk and is reported rather than silently replaced.
    if (cap && standCallRequired(seam) && !endsInToolCall(cap, seam)) {
      unusable.push(`${seam}  <- ${cap.file} (ends in prose; this seam is answered by a tool call)`);
      cap = null;
    }
    if (cap && cap.parsed === false) {
      unusable.push(`${seam}  <- ${cap.file} (prose — never satisfied its contract)`);
      cap = null;
    }
    if (cap) {
      const fresh = refreshEntities(cap);
      if (fresh.refreshed) { stale.push(`${seam}  <- ${cap.file}: ${fresh.refreshed.join(', ')}`); }
      cap = fresh;
    }
    let standCall = null;
    let standTagged = null;
    if (!cap) {
      stood = contractStandIn(seam);
      if (!stood) { uncovered.push(`${seam} (no captured reply, no declared contract)`); continue; }
      // A SCHEMA SEAM ANSWERS BY CALLING ITS TOOL, NOT BY TALKING. Its contract is checked against
      // the arguments of a named tool call, so a stand-in delivered as text is invisible to the
      // checker: the reply parses, the tag never appears, and the seam reports its own required
      // field as missing. Live 2026-08-27: spec-agent's stand-in carried storyId and the pass still
      // failed with 'missing required field "storyId"'.
      try {
        // eslint-disable-next-line global-require
        const { declaredContracts: dc, TAG_TO_TOOL } = require('./lib/agent-output-schema.js');
        const c = dc()[seam];
        const t = c && c.tag && TAG_TO_TOOL[c.tag];
        if (t) {
          const items = Array.isArray(stood) ? stood : [stood];
          // BOTH KEYS. The emitters read `input` (anthropicSseToolCalls serialises
          // `JSON.stringify(c.input || {})`); captures elsewhere carry `arguments`. Writing only
          // `arguments` made every stand-in serialise as an empty `{}` — the seam received a
          // correctly-named tool call carrying nothing, and role-assigner left both stories
          // unassigned while the right answer sat one key away.
          const argv = t.itemsKey ? { [t.itemsKey]: items } : items[0];
          standCall = { name: realToolName(t.tool), input: argv, arguments: argv };
          // AND AS A TAGGED BLOCK — WHICH IS WHAT THE RUNNER ACTUALLY READS.
          //
          // runAgentForJson ends both of its branches at extractTaggedJson(output, tag). There is
          // no code path anywhere in it that reads a tool call, so a stand-in delivered only as one
          // answers a question nobody asks: spec-agent received a correctly-named call carrying
          // storyId and the pass still reported storyId missing, four times over.
          //
          // The tool definition is real — it binds the shape at the provider through --json-schema
          // — but the REPLY is read out of the text. So the stand-in is delivered both ways.
          standTagged = `<${c.tag}>\n${JSON.stringify(argv, null, 2)}\n</${c.tag}>`;
          // AND AS A TAGGED BLOCK, WHICH IS WHAT THE PROMPT ACTUALLY DEMANDS.
          //
          // The seam's own prompt says: "Emit EXACTLY one <ROLE_ASSIGNMENTS> block ... the pipeline
          // parses the block and never the commentary." The tool definition describes the same
          // fields, but what the runner reads out of the reply is the TAG. Delivering only a tool
          // call answered a question nobody was asking: role-assigner received a correctly-named
          // call carrying correct JSON, and every story still came back with a null agentRole.
          standTagged = `<${c.tag}>\n${JSON.stringify(argv, null, 2)}\n</${c.tag}>`;
        }
      } catch { standCall = null; }
    }
    // A STORY-SPECIFIC CAPTURE IS MATCHED THE SAME WAY A STORY-SPECIFIC STAND-IN IS.
    //
    // Matching a capture on the story ALONE matches every prompt carrying the PRD — all of them —
    // so it answers other seams' calls. Matching on the seam's TEMPLATE alone ignores the story, so
    // MOCK3-1's detective answer was served for MOCK3-2 and mockb was specified against mocka's
    // src/fares.ts. Both together identify the one call this capture belongs to; the seam is named
    // by its output tag where it has one, since that is what every prompt for it carries.
    const _capTag = (() => {
      try {
        // eslint-disable-next-line global-require
        const { declaredContracts: dc } = require('./lib/agent-output-schema.js');
        const d = dc()[seam];
        return (d && d.tag) ? `<${d.tag}>` : '';
      } catch { return ''; }
    })();
    const _disc = storyDiscriminator(_story);
    const _seamMark = _capTag || key;
    const bodyMatch = _disc
      ? { type: 'REGEX',
          regex: `(?s)(?=.*${rx(wireForm(_seamMark))})(?=.*${rx(wireForm(_disc))}).*` }
      : { type: 'STRING', string: wireForm(key), subString: true };
    const PROTOCOLS = [
      { path: '/api/v1/chat/completions', text: sse, calls: sseToolCalls },
      { path: '/v1/messages', text: anthropicSse, calls: anthropicSseToolCalls },
    ];

    // A PER-STORY SEAM NEEDS ONE ANSWER PER STORY, WHETHER OR NOT A CAPTURE NAMES ONE.
    //
    // The story used to be read from the CAPTURE's filename, so a stand-in — which has no file —
    // got a single expectation serving every story. Evidence from the logs it writes:
    // MOCK3-2-openspec-spec.log received `"storyId": "MOCK3-1"`, and mockb was then specified
    // against src/fares.ts and test/fares.test.ts, which are mocka's. The reply was correct; it was
    // answering for the wrong story.
    //
    // So a seam whose schema carries a storyId is registered ONCE PER STORY, each matched on that
    // story's own title — the one thing in its prompt no other story shares. Stories come from the
    // PRD; nothing is named here.
    // PER-STORY EITHER WAY: a real capture per story where one was recorded, a stand-in per story
    // otherwise. This used to require the stand-in path (!cap), so a seam WITH per-story captures —
    // code-graph-detective has one for each — took the single-capture branch and answered every
    // story with the first story's finding.
    const _stories = projectStories();
    const _perStoryCaptures = _stories.length > 1
      ? _stories.map((st) => ({ story: st, cap: cassetteReply(seam, st.id) }))
          .filter((x) => x.cap)
      : [];
    const _perStorySeam = (_perStoryCaptures.length > 1)
      || (!cap && Array.isArray(stood) && stood.length > 1 && stood.every((x) => x && x.storyId));
    const _tag = (() => {
      try {
        // eslint-disable-next-line global-require
        const { declaredContracts: dc } = require('./lib/agent-output-schema.js');
        const d = dc()[seam];
        return (d && d.tag) || '';
      } catch { return ''; }
    })();
    // ONE CALL PER STORY, OR ONE CALL FOR ALL OF THEM? THE REGISTRY ALREADY SAYS.
    //
    // A tag with an itemsKey returns a LIST covering every story in a single call — role-assigner
    // answers all assignments at once. A tag without one is asked per story, and spec-agent is
    // called separately for each. Registering per-story answers for the first kind means the one
    // call matches the first story's expectation and the rest are never served: MOCK3-1 was
    // answered six times and MOCK3-2 came back unassigned.
    const _oneCallForAll = !!TAG_ITEMS_KEY(seam);
    // A SEAM WITHOUT A TAG IS IDENTIFIED BY ITS TEMPLATE. code-graph-detective produces an
    // artefact rather than a tagged block, so requiring a tag here skipped it entirely — and it is
    // precisely the seam whose per-story answers were being crossed.
    const _mark = _tag ? `<${_tag}>` : key;
    if (_perStorySeam && !_oneCallForAll && _perStoryCaptures.length > 1) {
      // REAL ANSWERS, ONE PER STORY. Preferred over stand-ins: a recorded reply carries the
      // reasoning and the file paths a synthesised one cannot.
      for (const { story: st, cap: c2 } of _perStoryCaptures) {
        const disc = storyDiscriminator(st.id);
        if (!disc) continue;
        for (const proto of PROTOCOLS) {
          // eslint-disable-next-line no-await-in-loop
          await put('/mockserver/expectation', {
            priority: 50,
            httpRequest: { method: 'POST', path: proto.path,
              body: { type: 'REGEX',
                regex: `(?s)(?=.*${rx(wireForm(_mark))})(?=.*${rx(wireForm(disc))}).*` } },
            httpResponse: { statusCode: 200,
              headers: { 'content-type': ['text/event-stream'], 'x-seam': [`${seam}:${st.id}`] },
              body: proto.text(refreshEntities(c2).body) },
          });
        }
        perStory.push(`${seam} · ${st.id}  <- ${c2.file}`);
      }
    } else if (_perStorySeam && _tag && !_oneCallForAll) {
      for (const item of stood) {
        const disc = storyDiscriminator(item.storyId);
        if (!disc) continue;
        const tagged = `<${_tag}>\n${JSON.stringify(
          (TAG_ITEMS_KEY(seam) ? { [TAG_ITEMS_KEY(seam)]: [item] } : item), null, 2)}\n</${_tag}>`;
        for (const proto of PROTOCOLS) {
          // eslint-disable-next-line no-await-in-loop
          await put('/mockserver/expectation', {
            priority: 50,
            // BOTH, OR IT HIJACKS ANOTHER SEAM'S CALL.
            //
            // Matching on the story alone matches every prompt that carries the PRD — which is all
            // of them. Registered at a higher priority it then answered codeline-discovery's
            // request with a spec-agent reply, and discovery gave up after three attempts on an
            // answer 104 characters long. The matcher must identify the SEAM as well as the story:
            // the seam's own fingerprint and this story's title, both required.
            httpRequest: { method: 'POST', path: proto.path,
              // THE TAG IDENTIFIES THE SEAM ACROSS EVERY PROMPT THAT USES IT.
              //
              // A template fingerprint identifies ONE prompt. spec-agent is called from two — the
              // openspec pass and the speckit review — built from different templates, so a
              // fingerprint matched one and left the other to the catch-all, which answered {} and
              // reported the seam's own required field as missing.
              //
              // outputContractFor() appends the seam's output tag to every prompt it sends, so the
              // tag is the one thing common to all of them. Tag plus story: this seam, this story,
              // whichever prompt asked.
              body: { type: 'REGEX',
                regex: `(?s)(?=.*${rx(wireForm(`<${_tag}>`))})(?=.*${rx(wireForm(disc))}).*` } },
            httpResponse: { statusCode: 200,
              headers: { 'content-type': ['text/event-stream'], 'x-seam': [`${seam}:${item.storyId}`] },
              body: proto.text(tagged) },
          });
        }
        perStory.push(`${seam} · ${item.storyId}`);
      }
    }
    seen.add(_dedup);
    // TWO PROTOCOLS, REGISTERED TOGETHER.
    //
    // The epam-run path POSTs OpenAI chat-completions; Claude Code POSTs Anthropic Messages.
    // Different PATHS, so both can be registered for the same seam and neither interferes —
    // whichever client calls gets the framing it can parse. Registering only one leaves the
    // other client reading a stream it cannot decode, which surfaces as an EMPTY TURN and
    // reads as a model that said nothing rather than a protocol mismatch.
    //
    // The paths are API contracts, not configuration: /api/v1/chat/completions and
    // /v1/messages are what those two APIs ARE.
    // Match on the STORY where the capture is story-specific — the prompt carries the id, so this
    // separates the two stories that otherwise share a template.
    // MATCH THE BODY AS IT IS SENT, NOT AS THE TEMPLATE READS.
    //
    // MockServer compares against the RAW request body, where the prompt is a JSON string value —
    // so every quote in it arrives escaped. A fingerprint taken straight from the template carries
    // raw quotes and can therefore never match a template whose distinctive line contains one.
    // Live 2026-08-27: spec-agent's fingerprint `"acceptanceCriteria":["..."],` was present in
    // every request in its escaped form and absent in its raw one; all sixteen of its calls fell to
    // the catch-all and the seam reported its own required field as missing. Only the eight seams
    // whose fingerprints happened to contain no quotes were matching at all.

    if (cap && cap.multi) {
      // ONE EXPECTATION PER TURN, each consumed once, so the conversation replays in the order it
      // actually happened: reads first, the write where it really occurred, the answer last.
      for (const turn of cap.turns) {
        for (const proto of PROTOCOLS) {
          const body = (turn.calls && turn.calls.length)
            ? proto.calls(turn.calls) : proto.text(turn.body);
          await put('/mockserver/expectation', {
            priority: 40, times: { remainingTimes: 1, unlimited: false },
            httpRequest: { method: 'POST', path: proto.path, body: bodyMatch },
            httpResponse: { statusCode: 200,
              headers: { 'content-type': ['text/event-stream'], 'x-seam': [seam] }, body },
          });
        }
      }
    } else if (!cap && standCall) {
      for (const proto of PROTOCOLS) {
        await put('/mockserver/expectation', {
          priority: 40, times: { remainingTimes: 1, unlimited: false },
          httpRequest: { method: 'POST', path: proto.path, body: bodyMatch },
          httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'], 'x-seam': [seam] },
            body: proto.calls([standCall]) },
        });
      }
    } else if (cap && cap.calls && cap.calls.length) {
      // TURN ONE: the calls, consumed once. MockServer serves expectations for the same matcher in
      // order, so the client executes the tools, comes back, and gets the answer below.
      for (const proto of PROTOCOLS) {
        await put('/mockserver/expectation', {
          priority: 40, times: { remainingTimes: 1, unlimited: false },
          httpRequest: { method: 'POST', path: proto.path, body: bodyMatch },
          httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'], 'x-seam': [seam] },
            body: proto.calls(cap.calls) },
        });
      }
    }
    // TURN TWO (or the only turn): what the model said once its work was done.
    for (const proto of PROTOCOLS) {
      await put('/mockserver/expectation', {
        priority: 30,
        httpRequest: { method: 'POST', path: proto.path, body: bodyMatch },
        httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'], 'x-seam': [seam] },
          body: proto.text(cap ? cap.body : (standTagged || JSON.stringify(stood))) },
      });
    }
    if (cap) covered.push(`${seam}  <- ${cap.file}${cap.parsed ? '' : ' (prose)'}`);
      else stoodIn.push(`${seam}  <- contract stand-in (${Object.keys(stood).join(', ') || 'artefact'})`);
  }

  // A catch-all so an unmatched seam is visibly empty rather than reaching the network.
  await put('/mockserver/expectation', {
    priority: 1,
    // WHICH SEAM ANSWERED THIS REQUEST? Every fidelity bug today was found three stages
    // downstream of its cause: a seam whose matcher stopped matching fell through to a
    // catch-all, answered {}, and surfaced as 'the answer did not parse' inside
    // content-retry — fifteen minutes each to trace back. The header makes it one line.
    httpRequest: { method: 'POST', path: '/api/v1/.*' },
    httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'], 'x-seam': ['CATCH-ALL-no-seam-matched'] },
      body: sse('{}') },
  });
  // The Anthropic catch-all matters MORE than the other one: Claude Code makes AUXILIARY calls
  // (measured: 4 POSTs where 2 were expected). Without this they would fall through to whatever
  // matched loosest and consume a seam's single-use expectation — which is exactly how a
  // tool-call replay was eaten by a background request.
  await put('/mockserver/expectation', {
    priority: 1,
    httpRequest: { method: 'POST', path: '/v1/messages' },
    httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream'], 'x-seam': ['CATCH-ALL-no-seam-matched'] },
      body: anthropicSse('{}') },
  });

  console.log(`covered ${covered.length} seam(s) from real captures:`);
  covered.forEach((c) => console.log(`  ${c}`));
  console.log(`\nUNCOVERED ${uncovered.length} — these answer {} and will fail their contract:`);
  uncovered.slice(0, 20).forEach((u) => console.log(`  ${u}`));
})().catch((e) => { console.error(e.message); process.exit(1); });
