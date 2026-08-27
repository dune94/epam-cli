#!/usr/bin/env node
/**
 * llm-call.js — THE ONE NODE-SIDE FACE OF THE LLM HUB.
 *
 * Every LLM call in the pipeline goes through one central handler (llm-handler.sh), which
 * dispatches to a vendor handler. This module is how JavaScript callers reach it.
 *
 * WHY IT EXISTS. Nine JS call sites each hand-rolled their own invocation — ac-gate,
 * kb-cli, kb-synthesizer, cpa-inference, mint-agents-step, spec-mode-runner,
 * detective-rerun-step, codeline-discovery and topology-router. Each resolved its own
 * provider, read its own credential and set its own timeout. A fix to one never reached the
 * others: on 2026-08-25 a run labelled `mockserver` billed a real API for 34 minutes because
 * the free-run seal held at some of those sites and not at others.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It resolves NO vendor facts. No credential is read here,
 * no base URL is chosen here, no vendor is named here. Those belong to the hub and to the
 * active provider set. A caller that needs a different vendor changes the SET, not this file.
 * A scanner enforces the absence (see config/llm-channel.json).
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

// THE HUB, IN ONE PLACE. Callers used to each join their own path to the runner, so the
// rename of ai-run.sh -> llm-handler.sh would have been a nine-site edit.
function hubPath() {
  return path.join(__dirname, '..', 'llm-handler.sh');
}

/**
 * callLlm({ seam, prompt, model, provider, timeoutMs, env, hubPath })
 *
 * Returns the hub's stdout as text. Rejects if the hub fails or writes nothing — an empty
 * response is a FAILURE, never a quiet fallback. A seam that silently degrades on an empty
 * answer reports success while having asked nobody anything.
 */
function callLlm(opts = {}) {
  const {
    seam = '',
    prompt = '',
    model = '',
    provider = '',
    timeoutMs = 0,
    env = process.env,
  } = opts;

  const hub = opts.hubPath || hubPath();

  // The provider is the SET'S decision, surfaced through the environment the launcher built.
  // Named here only to pass through: this module never picks one.
  const resolvedProvider = provider
    || env.AI_PROVIDER
    || env.EPAM_ORCHESTRATION_PROVIDER
    || '';

  const args = [];
  if (resolvedProvider) args.push('--provider', resolvedProvider);
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [hub, ...args], {
      env: { ...env, ...(seam ? { EPAM_AGENT_NAME: seam } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let timer = null;
    let settled = false;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        done(reject, new Error(`[llm-call] ${seam || 'call'} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      if (code !== 0) {
        return done(reject, new Error(`[llm-call] ${seam || 'call'} exited ${code}${err ? ` — ${err.trim()}` : ''}`));
      }
      if (!out.trim()) {
        return done(reject, new Error(`[llm-call] ${seam || 'call'} returned an empty response${err ? ` — ${err.trim()}` : ''}`));
      }
      done(resolve, out);
    });

    if (prompt) child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * callLlmJson(opts) — the same call, parsed. Rejects when the text is not JSON, rather than
 * returning a shape the caller then treats as an answer.
 */
async function callLlmJson(opts = {}) {
  const text = await callLlm(opts);
  const trimmed = String(text).trim();
  // Models wrap JSON in prose or fences often enough that the first brace is the honest
  // start; anything before it is commentary, not data.
  const start = trimmed.search(/[[{]/);
  if (start === -1) throw new Error(`[llm-call] ${opts.seam || 'call'} returned no JSON: ${trimmed.slice(0, 200)}`);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  return JSON.parse(trimmed.slice(start, end + 1));
}

module.exports = { callLlm, callLlmJson, hubPath };
