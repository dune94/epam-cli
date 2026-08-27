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

/** Config, entirely from the environment the run already loads. Absent means disabled. */
function config(env) {
  const pk = env.LANGFUSE_PUBLIC_KEY || '';
  const sk = env.LANGFUSE_SECRET_KEY || '';
  // BOTH KEYS OR NEITHER. One key alone authenticates nothing, and a half-configured backend
  // that silently drops events is worse than one that is plainly off.
  if (!pk || !sk) return null;
  return { pk, sk, base: (env.LANGFUSE_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '') };
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
async function emitGeneration(f = {}, env = process.env) {
  const cfg = config(env);
  if (!cfg) return false;
  if (typeof fetch !== 'function') return false;

  const session = sessionId(env);
  const name = f.agent || 'llm-call';
  const started = f.startedAt || new Date().toISOString();
  const ended = f.endedAt || new Date().toISOString();
  // Stable per call, so a retried emit updates rather than duplicating.
  const traceId = `${session || 'run'}-${name}-${started}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120);
  const genId = `${traceId}-gen`;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
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

  try {
    const ctl = new AbortController();
    // A backend that does not answer promptly must not hold up the pipeline.
    const timer = setTimeout(() => ctl.abort(), Number(env.LANGFUSE_TIMEOUT_MS || 4000));
    const res = await fetch(`${cfg.base}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${cfg.pk}:${cfg.sk}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { emitGeneration, config, sessionId };

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
