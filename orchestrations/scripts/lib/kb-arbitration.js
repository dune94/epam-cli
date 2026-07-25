/**
 * kb-arbitration.js — PILLAR 2. Conflict resolution and knowledge pruning.
 *
 * A self-healed rule is only correct for the system as it stood when it was
 * written. Once the underlying code moves, yesterday's fix becomes today's drift.
 * Two mechanisms guard that, neither of which exists in the current pipeline:
 *
 *   admit()  Runs a conflict merge BEFORE a rule enters the store. Contradiction
 *            archives the stale rule with `superseded_by` set; an identical rule
 *            merges origin_episodes instead of duplicating.
 *   tick()   Ages rules that did not fire this cycle. At ttl expiry the rule is
 *            archived for re-validation rather than trusted indefinitely.
 *
 * FAILS CLOSED, deliberately. The behaviour being replaced is
 * `run_failure_analyst`'s `[unreviewed-fallback]` path, which persists a note even
 * after the reviewer rejects it three times. A write path that cannot say no is a
 * drift generator, not a safety net. Here, an invalid rule is rejected and the
 * store is left untouched.
 *
 * NOTHING IS DELETED. Superseded and expired rules are marked archived in place and
 * appended to constraints.archive.jsonl, so a wrong arbitration decision stays
 * auditable and reversible — the same reason we archive logs rather than truncate.
 *
 * Conflict is decided STRUCTURALLY, not by asking a model: two rules conflict when
 * they bind the same scope+trigger and their enforcement targets the same knob with
 * a different value. That is decidable from the schema, so it cannot itself drift.
 */
'use strict';

const fs = require('fs');

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Same scope and same trigger — i.e. both rules claim the same situation. */
function sameBinding(a, b) {
  return a.trigger?.signature === b.trigger?.signature &&
    (a.trigger?.phase || null) === (b.trigger?.phase || null) &&
    (a.scope?.global === true) === (b.scope?.global === true) &&
    (a.scope?.agent_role || null) === (b.scope?.agent_role || null);
}

/** The knob a rule turns. Two rules on the same knob must agree or one must go. */
function knob(c) {
  const e = c.enforcement || {};
  switch (e.kind) {
    case 'param': return `param:${e.name}`;
    case 'gate': return `gate:${e.check}`;
    case 'tool_scope': return 'tool_scope';
    default: return `unknown:${e.kind}`;
  }
}

const sameEffect = (a, b) =>
  JSON.stringify(a.enforcement) === JSON.stringify(b.enforcement);

function archive(store, rule, supersededBy) {
  const list = store.readConstraints();
  const i = list.findIndex(x => x.id === rule.id);
  if (i < 0) return;
  list[i] = { ...list[i], status: 'archived', ...(supersededBy ? { superseded_by: supersededBy } : {}) };
  store.writeConstraints(list);
  fs.appendFileSync(store._paths().archive,
    JSON.stringify({ ts: nowIso(), reason: supersededBy ? 'superseded' : 'ttl-expired', rule: list[i] }) + '\n');
}

/**
 * Admit a candidate rule after arbitration.
 * Throws (leaving the store untouched) if the candidate is not schema-valid.
 */
function admit(store, candidate) {
  // Validate FIRST: an invalid rule must never cause an archive as a side effect.
  store.validate('constraint', candidate);

  const active = store.readConstraints().filter(x => x.status !== 'archived');
  for (const existing of active) {
    if (!sameBinding(existing, candidate)) continue;
    if (knob(existing) !== knob(candidate)) continue;      // different knob: coexist

    if (sameEffect(existing, candidate)) {
      // Same rule arrived again — merge the evidence, do not duplicate the rule.
      const merged = {
        ...existing,
        origin_episodes: Array.from(new Set([
          ...(existing.origin_episodes || []), ...(candidate.origin_episodes || []),
        ])),
        cycles_idle: 0,
      };
      return store.putConstraint(merged);
    }
    // Same knob, different value -> genuine contradiction. Newest wins; the stale
    // rule is archived rather than left to fight it.
    archive(store, existing, candidate.id);
  }
  return store.putConstraint({ ...candidate, cycles_idle: 0 });
}

/**
 * Advance one cycle. `fired` lists constraint ids that actually applied.
 * @returns the rules archived by TTL expiry this tick.
 */
function tick(store, { fired = [] } = {}) {
  const list = store.readConstraints();
  const expired = [];
  const next = list.map(c => {
    if (c.status === 'archived') return c;
    if (fired.includes(c.id)) return { ...c, cycles_idle: 0, last_fired: nowIso() };
    const idle = (c.cycles_idle || 0) + 1;
    if (idle >= (c.ttl_cycles ?? 20)) {
      const arch = { ...c, cycles_idle: idle, status: 'archived' };
      expired.push(arch);
      return arch;
    }
    return { ...c, cycles_idle: idle };
  });
  store.writeConstraints(next);
  for (const e of expired) {
    fs.appendFileSync(store._paths().archive,
      JSON.stringify({ ts: nowIso(), reason: 'ttl-expired', rule: e }) + '\n');
  }
  return expired;
}

module.exports = { admit, tick, sameBinding, knob, sameEffect };
