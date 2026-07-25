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
const store = require('./kb-store.js');
const arb = require('./kb-arbitration.js');
const compiler = require('./constraint-compiler.js');
const { buildEpisode } = require('./failure-signature.js');

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
  const signatures = String(arg('signatures') || '').split(',').map(s => s.trim()).filter(Boolean);
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
  // Ids of the rules that fired — the caller passes these to arbitration's TTL
  // tick, so a rule that keeps applying stays alive and one that never does ages out.
  lines.push(`export KB_FIRED=${q(matched.map(m => m.id).join(','))}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  configure();
  switch (process.argv[2]) {
    case 'record': return cmdRecord();
    case 'synthesize': return cmdSynthesize();
    case 'apply': return cmdApply();
    default:
      process.stderr.write('usage: kb-cli.js record|synthesize|apply [...]\n');
      process.exit(2);
  }
}

main();
