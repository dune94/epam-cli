#!/usr/bin/env node
/**
 * self-heal.js — EVERY AGENT REACHES THE ANALYST, AND IT IS SENT WHAT ACTUALLY CAME BACK.
 *
 * agent-attempt-analyst.sh is the self-heal for an agent that fails by producing no usable output.
 * Its own header has said "Used by: brownfield-repro-test-writer.sh (now), the code-graph-detective
 * (next)" since it was written — and "next" never arrived. One seam of forty had self-heal; the
 * other thirty-nine retried blind, re-running a model with nothing but the same instruction.
 *
 * Live 2026-08-27: seven prompt generations were refused and retried across two runs, and not one
 * of those failures ever reached the analyst. The refusal text was fed back to the model; the
 * episode was never recorded and no constraint was ever synthesised from it.
 *
 * This is the JS edge of that one analyst, so a retry loop written in JavaScript reaches the same
 * script the bash seams use. It does not reimplement any part of it.
 *
 * THE FAILED OUTPUT IS THE POINT. The analyst diagnoses WHY an agent failed, which it cannot do
 * from a reason string alone — it needs the bytes the agent actually produced. Callers pass them;
 * this writes them where the analyst expects to read them.
 *
 * BEST-EFFORT, NEVER BLOCKING. The analyst is a diagnostic, and a diagnostic that can fail a run
 * is worse than none. Exit 2 (the analyst itself broke) is REPORTED rather than swallowed, because
 * the next attempt then runs with no corrective and that must be visible.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Whatever the caller returned, as text. `output`/`context` are routinely an already-parsed
 * object — codeline-discovery.js's `call` returns callLlm(...), never a string, and
 * content-retry.js hands that straight through. `String(obj)` yields the single word
 * "[object Object]", the only evidence the analyst gets discarded before it ever sees it.
 */
function _asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** The failure classes the analyst distinguishes. Derived from what the caller saw, never guessed. */
function classify(reason, output) {
  const r = `${reason || ''}`.toLowerCase();
  const o = `${output || ''}`;
  if (!o.trim()) return 'no-output';
  if (/timed out|timeout/.test(r)) return 'provider';
  if (/max iterations|iteration budget/.test(r)) return 'max-iterations';
  if (/json|parse|unparseable|no json/.test(r)) return 'no-json';
  if (/placeholder|output field|contract|shape/.test(r)) return 'malformed';
  return 'malformed';
}

/**
 * selfHeal({ agent, storyId, reason, output, context, logDir })
 *
 * Returns { ran, rc, corrective } — never throws.
 *   rc 0 + corrective : the analyst prescribed a directive for the next attempt
 *   rc 0 + none       : deliberate skip (provider/infra: no agent behaviour to correct)
 *   rc 2              : the analyst itself failed; the next attempt has no guidance
 */
function selfHeal({ agent, storyId, reason, output, context, logDir, model, provider, runner,
  projectConfigDir } = {}) {
  const script = path.join(__dirname, '..', 'agent-attempt-analyst.sh');
  if (!fs.existsSync(script)) return { ran: false, rc: 0, corrective: '' };

  let outFile = '';
  let ctxFile = '';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-'));
    outFile = path.join(dir, 'failed-output.txt');
    // WHAT THE AGENT ACTUALLY RETURNED, in full. A reason string says which rule was broken; only
    // the output says why the agent broke it.
    fs.writeFileSync(outFile, _asText(output));
    if (context) {
      ctxFile = path.join(dir, 'context.txt');
      fs.writeFileSync(ctxFile, _asText(context));
    }
  } catch { return { ran: false, rc: 0, corrective: '' }; }

  const args = [script, classify(reason, output), outFile];
  if (ctxFile) args.push(ctxFile);
  try {
    const r = spawnSync('bash', args, {
      encoding: 'utf8',
      timeout: Number(process.env.EPAM_SELF_HEAL_TIMEOUT_MS || 0) || undefined,
      env: {
        ...process.env,
        // THE ANALYST IS A SEPARATE PROGRAM, NOT A CHILD OF WHOEVER CALLED US.
        //
        // It shells out to plain `node` for kb-cli, and any node flags in the caller's environment
        // are inherited by that grandchild. Under a runner that instruments node — a test runner,
        // a profiler, a coverage tool — those flags break it, and the failure is invisible because
        // the record step ends in `|| true`: the analyst reports "diagnosing" and no episode is
        // ever written. Reproduced exactly that way; the same call recorded an episode from a
        // plain shell and recorded nothing under vitest.
        NODE_OPTIONS: '',
        // AND THE NODE TO RUN IT WITH. kb-apply.sh resolves `node` from PATH to record the episode.
        // A caller whose node is not ON the path — anything under nvm, which is this project's
        // documented setup — leaves that step unable to run, and it ends in `|| true`, so the
        // analyst reports "diagnosing" and no episode is ever written. Stated explicitly, since we
        // are already running under the node the pipeline expects.
        NODE_BIN: process.env.NODE_BIN || process.execPath,
        PATH: `${require('path').dirname(process.execPath)}:${process.env.PATH || ''}`,
        AGENT_ANALYST_STORY_ID: storyId || process.env.EPAM_STORY_ID || '',
        STORY_ROLE: agent || process.env.EPAM_AGENT_NAME || '',
        // THE RUNG THAT PRODUCED THE FAILURE, WITHOUT WHICH THE ANALYST DOES NOTHING.
        //
        // agent-attempt-analyst.sh resolves its model from AGENT_ANALYST_MODEL, then the rung, then
        // ESCALATION_MODEL, then EPAM_MODEL — and with none of them set it exits 0 SILENTLY:
        // "Not analysing rather than guessing a model." That is the right call and it made this
        // whole mechanism inert: a seam's model lives in its per-call env, never in process.env, so
        // nothing reached the analyst and it declined every single time.
        //
        // Live 2026-08-27, run 20260827T151832Z: seven refusals, ZERO healing episodes recorded and
        // zero rc=2 — the analyst was not failing, it was declining, and the two are
        // indistinguishable from the outside.
        //
        // Passing it also honours the standing rule that the analyst heals on the rung that
        // PRODUCED the work: the producer states the model, and it travels as a parameter.
        ...(model ? { AGENT_ANALYST_MODEL: String(model) } : {}),
        ...(provider ? { AGENT_ANALYST_PROVIDER: String(provider) } : {}),
        ...(logDir ? { LOG_DIR: logDir } : {}),
        // Overridable so the ACTIONABLE path can be exercised against a stub runner instead of a
        // real model. Without it the only affordable test case is the one the analyst skips — which
        // is exactly the single happy path that let a declining mechanism look wired.
        ...(runner ? { AI_RUNNER_CMD: String(runner) } : {}),
        // THE PROJECT, STATED RATHER THAN INHERITED. The KB the analyst records into roots at
        // EPAM_PROJECT_CONFIG_DIR/kb, and reading it from ambient env made the outcome depend on
        // whatever else had touched process.env — the same call recorded an episode when run
        // directly and recorded nothing under test. A parameter cannot be mutated by a neighbour.
        ...(projectConfigDir ? { EPAM_PROJECT_CONFIG_DIR: String(projectConfigDir) } : {}),
      },
    });
    const rc = r.status == null ? 0 : r.status;
    const corrective = (r.stdout || '').trim();
    // DECLINED IS NOT "PRODUCED NO CORRECTIVE".
    //
    // The analyst deliberately returns NOTHING on stdout — it records an episode and synthesises a
    // constraint instead — so empty output is its NORMAL success path. Reading emptiness as a
    // decline reported every healthy analysis as a failure, which is the mirror of the defect this
    // field exists to expose. The real signals are on stderr: it says which model it is diagnosing
    // via, or why it will not.
    const err = String(r.stderr || '');
    const analysed = /diagnosing\s+\S+\s+via\s+\S+/.test(err);
    const why = (err.match(/no model resolved[^\n]*|settings file not found[^\n]*|cannot render[^\n]*/) || [''])[0];
    const declined = rc === 0 && !analysed && !corrective;
    return { ran: true, rc, corrective, analysed, declined, declinedReason: why, stderr: err };
  } catch {
    return { ran: false, rc: 0, corrective: '', declined: false, declinedReason: '' };
  }
}

module.exports = { selfHeal, classify, _asText };
