#!/usr/bin/env node
/**
 * kb-cli.js — the only seam between the shell pipeline and the self-heal KB.
 *
 *   record     read tool output on stdin, append an episode keyed by the
 *              TOOL-DERIVED signature (never by the model's prose)
 *   synthesize collapse this signature's episodes into one arbitrated constraint
 *   apply      emit shell `export` lines + KB_GATES for the caller
 *
 * `apply` emits ONLY env assignments and gate ids. There is deliberately no
 * free-text channel: healed knowledge physically cannot degrade back into a prompt
 * appendix. That is the failure being replaced — the current path ends in
 * COORDINATOR_PROMPT_AMENDMENT, appended text silently trimmed to the last three
 * headings past ~16000 chars, with nothing checking the agent obeyed it.
 *
 * Every write goes through arbitration (kb-arbitration.admit), so a contradicting
 * rule archives its predecessor instead of both being live, and an unenforceable
 * rule is rejected outright rather than persisted unreviewed.
 *
 * KB_ROOT overrides the store location (tests, per-project KBs).
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const store = require('./kb-store.js');
const arb = require('./kb-arbitration.js');
const compiler = require('./constraint-compiler.js');
const { buildEpisode } = require('./failure-signature.js');
const synthesizer = require('./kb-synthesizer.js');

function arg(name, dflt = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

const readStdin = () => {
  try { return require('fs').readFileSync(0, 'utf8'); } catch { return ''; }
};

function configure() {
  const root = process.env.KB_ROOT ||
    path.join(__dirname, '..', '..', 'agents', 'kb');
  store.configure({ root });
}

/** Shell-safe single-quoted value. */
const q = v => `'${String(v).replace(/'/g, `'\\''`)}'`;

function cmdRecord() {
  const ep = buildEpisode({
    id: arg('id') || `evt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    toolOutput: readStdin(),
    diagnosis: arg('diagnosis') || null,
    agent_role: arg('agent-role') || null,
    failure_class: arg('failure-class') || null,
    story_id: arg('story') || null,
    phase: arg('phase') || null,
    model: arg('model') || null,
  });
  // Drop undefined so the schema sees a clean record.
  Object.keys(ep).forEach(k => ep[k] === undefined && delete ep[k]);
  store.recordEpisode(ep);
  process.stdout.write(`${ep.signature || ''}\n`);
}

function cmdSynthesize() {
  const enforcement = JSON.parse(arg('enforcement') || '{}');
  const candidate = store.synthesize({
    agent_role: arg('agent-role') || undefined,
    signature: arg('signature'),
    phase: arg('phase') || undefined,
    enforcement,
    reason: arg('reason') || 'synthesised from repeated failures',
  });
  // synthesize() wrote a merged record; run it back through arbitration so a
  // contradicting predecessor is archived rather than left live beside it.
  arb.admit(store, candidate);
  process.stdout.write(`${candidate.id}\n`);
}

function cmdApply() {
  const role = arg('agent-role');
  let signatures = String(arg('signatures') || '').split(',').map(s => s.trim()).filter(Boolean);
  // --story derives the signatures from THIS story's own episodes, so the caller
  // does not have to track them across retries. Null signatures are skipped: an
  // episode we could not key must not match anything.
  const story = arg('story');
  if (story && !signatures.length) {
    signatures = Array.from(new Set(store.episodes()
      .filter(e => e.story_id === story && e.signature)
      .map(e => e.signature)));
  }
  const matched = [];
  for (const signature of signatures) {
    for (const c of store.lookup({ agent_role: role, signature })) {
      if (!matched.find(m => m.id === c.id)) matched.push(c);
    }
  }
  if (!matched.length) return;

  const { env, gates } = compiler.compile(matched);
  const lines = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`);
  if (gates.length) lines.push(`export KB_GATES=${q(gates.join(','))}`);

  // PILLAR 3 — digest the compiled surface so drift between apply and execution
  // is detectable. Between these two moments a wrapper can re-export a default, a
  // subshell can be spawned with a scrubbed env, or a later export can overwrite a
  // knob — and the agent then runs UNCONSTRAINED while the pipeline believes a
  // healed rule is in force. Worse than never applying it: the KB records a "fix
  // that didn't work" and ages the rule out.
  //
  // SCOPED to the variables we produced (KB_STATE_VARS), never the whole
  // environment: child shells legitimately mutate other vars, and a check that
  // cries wolf gets disabled.
  const covered = Object.keys(env).concat(gates.length ? ['KB_GATES'] : []).sort();
  const surface = { ...env, ...(gates.length ? { KB_GATES: gates.join(',') } : {}) };
  lines.push(`export KB_STATE_VARS=${q(covered.join(','))}`);
  lines.push(`export KB_STATE_DIGEST=${q(digestOf(covered, n => surface[n]))}`);
  // Ids of the rules that fired — the caller passes these to arbitration's TTL
  // tick, so a rule that keeps applying stays alive and one that never does ages out.
  lines.push(`export KB_FIRED=${q(matched.map(m => m.id).join(','))}`);
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * synthesize-auto — the LLM-driven step that turns REPEATED episodes into one
 * arbitrated constraint. Without this reachable from the shell, the loop is
 * record -> apply-finds-nothing forever: episodes accumulate, no rule is ever
 * built, and the KB is write-only while LOOKING enabled.
 *
 * Refusals are not silent: kb-synthesizer quarantines every path that does not
 * produce a rule (no_output / declined / unparseable / unmapped_rule).
 */
async function cmdSynthesizeAuto() {
  const c = await synthesizer.maybeSynthesize(store, {
    agent_role: arg('agent-role') || undefined,
    signature: arg('signature'),
    threshold: arg('threshold') ? Number(arg('threshold')) : undefined,
    runner: process.env.AI_RUNNER_CMD || undefined,
    model: arg('model') || undefined,
    provider: arg('provider') || undefined,
  });
  // Empty stdout = nothing synthesised. The REASON is in the quarantine log, not
  // here, so a caller cannot mistake prose for a result.
  if (c && c.id) process.stdout.write(`${c.id}\n`);
}

/**
 * tick — PILLAR 2 ageing. Rules that fired stay alive; rules that did not age
 * toward their TTL and are archived for re-validation rather than trusted
 * forever. --fired takes the KB_FIRED list emitted by `apply`.
 */
function cmdTick() {
  const fired = String(arg('fired') || '').split(',').map(s => s.trim()).filter(Boolean);
  const r = arb.tick(store, { fired });
  process.stdout.write(`${JSON.stringify(r || {})}\n`);
}

/**
 * Canonical digest of an enforced surface: name=value lines, sorted, newline
 * separated. A missing variable digests as the empty string, so STRIPPING a knob
 * changes the digest exactly as overwriting it does.
 */
function digestOf(names, read) {
  const canon = names.map(n => `${n}=${read(n) ?? ''}`).join('\n');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 32);
}

/**
 * verify-state — recompute the digest from the CURRENT environment and compare.
 * Exit 0 clean, 3 on drift (named, on stderr). Absence of state is not drift: with
 * nothing applied there is nothing to verify, so this must pass silently rather
 * than block every run that has no KB constraints.
 */
function cmdVerifyState() {
  const expected = process.env.KB_STATE_DIGEST;
  const varsRaw = process.env.KB_STATE_VARS;
  if (!expected || !varsRaw) return;               // nothing applied — nothing to check

  const names = varsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const actual = digestOf(names, n => process.env[n]);
  if (actual === expected) return;

  const drifted = names.filter(n => !process.env[n]);
  process.stderr.write(
    `[kb-verify-state] DRIFT: the enforced KB surface changed between apply and execution.\n` +
    `  expected=${expected} actual=${actual}\n` +
    (drifted.length ? `  missing/stripped: ${drifted.join(', ')}\n` : '') +
    `  covered: ${names.join(', ')}\n` +
    `  The agent would run UNCONSTRAINED while a healed rule is believed in force.\n`);
  process.exitCode = 3;
}

async function main() {
  configure();
  switch (process.argv[2]) {
    case 'record': return cmdRecord();
    case 'synthesize': return cmdSynthesize();
    case 'synthesize-auto': return cmdSynthesizeAuto();
    case 'apply': return cmdApply();
    case 'tick': return cmdTick();
    case 'verify-state': return cmdVerifyState();
    default:
      process.stderr.write('usage: kb-cli.js record|synthesize|synthesize-auto|apply|tick|verify-state [...]\n');
      process.exit(2);
  }
}

main();
