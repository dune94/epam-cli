#!/usr/bin/env node
/**
 * langfuse-emit.js — EVERY CALL THIS PIPELINE MAKES, TRACED, WHATEVER RAN IT.
 *
 * WHY THIS EXISTS. Tracing lived in src/observability/TracedProvider.ts, a decorator around the
 * TypeScript LLMProvider. That is reached only through the hub's `epam` arm. A run on any arm
 * that executes a vendor binary directly — which is how a subscription gets billed instead of an
 * API key — emitted nothing at all. Measured 2026-08-27: Langfuse held 84,145 traces and ZERO
 * from that day's runs, because the stack had changed and observability was a property of one
 * vendor path rather than of the pipeline.
 *
 * That is the hardcoding this project forbids, in its most expensive form: a capability that
 * silently applies to some stacks and not others. Observability belongs to the PIPELINE.
 *
 * WHERE IT IS CALLED FROM. The cost seam — the one place every call already passes, which
 * already holds the model, the token counts, the cost, the turn count and the timestamps. One
 * emitter, both paths (bash lib/cost-record.sh and JS lib/cost-emitter.js), so a fix reaches
 * every arm at once. Adding a vendor adds nothing here.
 *
 * NO VENDOR IS NAMED IN THIS FILE. Model, provider and agent all arrive as arguments, already
 * resolved by the layer whose job that is.
 *
 * IT MUST NEVER BREAK A CALL. Every failure path returns quietly: an observability backend that
 * is down, unreachable or unconfigured is a gap to report, never a reason to lose the work the
 * call just did.
 */
'use strict';

const { createHash } = require('crypto');

/** Config, entirely from the environment the run already loads. Absent means disabled. */
function config(env) {
  const pk = env.LANGFUSE_PUBLIC_KEY || '';
  const sk = env.LANGFUSE_SECRET_KEY || '';
  // BOTH KEYS OR NEITHER. One key alone authenticates nothing, and a half-configured backend
  // that silently drops events is worse than one that is plainly off.
  if (!pk || !sk) return null;
  // THE ENDPOINT IS DECLARED, NOT WRITTEN HERE. It was a literal, which the hardcoding audit
  // counted as a url/port — correctly: moving the backend would have meant editing engine code.
  // The environment still outranks the file, as everywhere else in this pipeline.
  const d = declared();
  // RESOLVED THE WAY EVERY OTHER ENDPOINT IN THIS PIPELINE RESOLVES, because this install already
  // knows where its own Langfuse is. This read LANGFUSE_BASE_URL and, finding it empty, gave up —
  // right about not GUESSING a host, wrong about having nothing to consult.
  //
  // Live 2026-09-04, pipeline-tests-17: no sessions and no traces while Langfuse was healthy on
  // :3110 and both keys had reached the run. The literal had been removed from .env earlier that
  // day — correctly, because it was pinned to :3100, the compose default, which is wrong for every
  // isolated install — on the assumption that the state-file fallback used everywhere else applied
  // here too. This was the one consumer with no such fallback, so removing the literal turned
  // emission off entirely, silently, on every install. "It worked in dev" was the tell: dev's
  // Langfuse really is on :3100.
  //
  // Order matches service_url(): an explicit env var outranks everything, then THIS install's
  // allocated port, then the declared default. Never a guess — every source is something the
  // operator or the installer actually stated.
  const base = env.LANGFUSE_BASE_URL || allocatedBase() || declaredBase() || '';
  // Absent stays absent: with no endpoint declared anywhere there is nothing to emit TO, and a
  // silent no-op is honest where a guessed host would post this run's data somewhere unintended.
  if (!base) return null;
  return { pk, sk, base: String(base).replace(/\/+$/, ''), timeoutMs: Number(env.LANGFUSE_TIMEOUT_MS || d.timeoutMs || 0) };
}

/** The install root: this file is <root>/orchestrations/scripts/lib/langfuse-emit.js. */
function installRoot() {
  return require('path').join(__dirname, '..', '..', '..');
}

/**
 * The port THIS install actually allocated for Langfuse, from the identity install.sh persists on
 * every successful bring-up — the same file service_url(), pre-run-reset.sh and
 * pipeline-services.sh all read. An isolated install's Langfuse is never on the compose default.
 */
function allocatedBase() {
  try {
    const fs = require('fs');
    const p = require('path').join(installRoot(), '.pipeline-services-state.env');
    const m = fs.readFileSync(p, 'utf8').match(/^OBS_LANGFUSE_PORT=(\d+)\s*$/m);
    return m ? `http://localhost:${m[1]}` : '';
  } catch { return ''; }
}

/** The declared default, from the service registry every other consumer reads. */
function declaredBase() {
  try {
    const fs = require('fs');
    const p = require('path').join(installRoot(), 'orchestrations', 'config', 'services.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j.services && j.services.langfuse && j.services.langfuse.url) || '';
  } catch { return ''; }
}

/** The project's declared observability settings. Absent is not an error — it is "not declared". */
let _declaredCache = null;
function declared() {
  if (_declaredCache) return _declaredCache;
  try {
    // eslint-disable-next-line global-require
    const cfg = require('../../config/observability.json');
    _declaredCache = (cfg && cfg.trace) || {};
  } catch { _declaredCache = {}; }
  return _declaredCache;
}

/**
 * THE SESSION IS THE RUN. Every trace carried sessionId null, so nothing in Langfuse could be
 * grouped into "the run that happened at 10:05" — the question an operator actually asks. The
 * run already stamps its own identity; this reads it rather than inventing a second one.
 */
function sessionId(env) {
  return env.EPAM_RUN_ID || env.RUN_NUMBER || env.ORCH_RUN_ID || '';
}

/**
 * emitGeneration(fields, env) -> Promise<boolean>
 *
 * One LLM call, as a Langfuse trace + generation. Returns false when disabled or when the
 * backend refused it; never throws.
 */
/**
 * THE INGESTION PAYLOAD, BUILT WHERE IT CAN BE TESTED.
 *
 * Kept separate from the POST so a test can assert what a trace CARRIES without a Langfuse to
 * send it to. The fields that were missing for the life of this pipeline — input and output —
 * are exactly the ones no test could have caught while the body was built inside the request.
 */
function buildIngestionBody(f, ids) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  const traceId = (ids && ids.traceId) || '';
  const genId = (ids && ids.genId) || `${traceId}-gen`;
  const started = (ids && ids.started) || f.startedAt || new Date().toISOString();
  const ended = (ids && ids.ended) || f.endedAt || started;
  const name = f.agent || f.name || 'agent';
  const session = (ids && ids.session) || '';
  const body = {
  batch: [
    {
      id: `${traceId}-t`,
      type: 'trace-create',
      timestamp: started,
      body: {
        id: traceId,
        name,
        // Absent stays absent: an empty sessionId is not a session.
        ...(session ? { sessionId: session } : {}),
        userId: f.storyId || undefined,
        metadata: {
          phase: f.phase || '',
          story_id: f.storyId || '',
          provider: f.provider || '',
          // The rung this call ran on — what makes an escalation visible here as well as in
          // the cost ledger.
          ladder_rung: f.rung === undefined || f.rung === null || f.rung === '' ? null : num(f.rung),
        },
        tags: [f.provider || '', f.phase || ''].filter(Boolean),
      },
    },
    {
      id: `${genId}-e`,
      type: 'generation-create',
      timestamp: started,
      body: {
        id: genId,
        traceId,
        name,
        startTime: started,
        endTime: ended,
        model: f.model || '',
        usage: {
          input: num(f.tokensIn),
          output: num(f.tokensOut),
          unit: 'TOKENS',
          totalCost: num(f.costUsd),
        },
        // WHAT WAS ACTUALLY SAID. Every observation this pipeline ever wrote read in=4ch out=4ch —
        // the string "null" — because the body carried no such fields. Cost and tokens were traced;
        // the prompt and the completion were not, for any agent, successful or failed. So a
        // content-shaped failure could only be diagnosed by paying for another run, and "replay it
        // from Langfuse" was never possible: there is nothing in there to replay.
        //
        // Absent stays absent: an empty string would read as "the model answered with nothing"
        // rather than "we never captured it".
        ...(f.input ? { input: f.input } : {}),
        ...(f.output ? { output: f.output } : {}),
        metadata: {
          turns: num(f.turns),
          cache_read_tokens: num(f.cacheRead),
          cache_create_tokens: num(f.cacheCreate),
          cost_is_estimate: !!f.costIsEstimate,
        },
      },
    },
  ],
  };
  return body;
}
async function emitGeneration(f = {}, env = process.env) {
  const cfg = config(env);
  if (!cfg) return false;
  if (typeof fetch !== 'function') return false;

  const session = sessionId(env);
  const name = f.agent || 'llm-call';
  const started = f.startedAt || new Date().toISOString();
  const ended = f.endedAt || new Date().toISOString();
  // Stable per call, so a retried emit updates rather than duplicating.
  // HASHED, NOT TRUNCATED. This sliced the composite to 120 chars, which is a truncation inside a
  // unit of meaning: two calls whose identity differed only past the cut would collide onto one
  // trace and the second would overwrite the first. A digest is stable, collision-free in practice
  // and bounded by construction, so nothing has to be cut.
  const traceId = createHash('sha1')
    .update(`${session || 'run'}\u0000${name}\u0000${started}`)
    .digest('hex');
  const genId = `${traceId}-gen`;

  const body = buildIngestionBody(f, { traceId, genId, started, ended, session });

  try {
    const ctl = new AbortController();
    // A backend that does not answer promptly must not hold up the pipeline.
    // No literal: the budget comes from the declaration resolved in config() above. A backend
    // that does not answer within it must not hold up the pipeline.
    const timer = cfg.timeoutMs > 0 ? setTimeout(() => ctl.abort(), cfg.timeoutMs) : null;
    const res = await fetch(`${cfg.base}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${cfg.pk}:${cfg.sk}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (timer) clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { emitGeneration, buildIngestionBody, config, sessionId };

// CLI edge, so the bash cost seam can use the SAME implementation rather than a second one
// written in jq and curl. Reads one JSON object on stdin.
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', async () => {
    let f = {};
    try { f = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    const ok = await emitGeneration(f, process.env);
    process.exit(ok ? 0 : 0); // never a failing status: this must not fail a call
  });
}
