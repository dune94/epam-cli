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
function selfHeal({ agent, storyId, reason, output, context, logDir } = {}) {
  const script = path.join(__dirname, '..', 'agent-attempt-analyst.sh');
  if (!fs.existsSync(script)) return { ran: false, rc: 0, corrective: '' };

  let outFile = '';
  let ctxFile = '';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-'));
    outFile = path.join(dir, 'failed-output.txt');
    // WHAT THE AGENT ACTUALLY RETURNED, in full. A reason string says which rule was broken; only
    // the output says why the agent broke it.
    fs.writeFileSync(outFile, String(output == null ? '' : output));
    if (context) {
      ctxFile = path.join(dir, 'context.txt');
      fs.writeFileSync(ctxFile, String(context));
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
        AGENT_ANALYST_STORY_ID: storyId || process.env.EPAM_STORY_ID || '',
        STORY_ROLE: agent || process.env.EPAM_AGENT_NAME || '',
        ...(logDir ? { LOG_DIR: logDir } : {}),
      },
    });
    return { ran: true, rc: r.status == null ? 0 : r.status, corrective: (r.stdout || '').trim() };
  } catch {
    return { ran: false, rc: 0, corrective: '' };
  }
}

module.exports = { selfHeal, classify };
