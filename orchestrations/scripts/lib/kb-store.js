/**
 * kb-store.js — the two-tier self-heal knowledge store (pillars 1 & 3).
 *
 *   EPISODIC   healing-events.jsonl  append-only, immutable, chronological.
 *                                    Evidence. NEVER read by an agent.
 *   PROCEDURAL constraints.json      deduplicated, enforceable rules. Keyed.
 *
 * Retrieval is a DETERMINISTIC keyed lookup on (agent_role, signature). Not vector
 * similarity, not a graph. Similarity search over failure logs is precisely what
 * produces over-correction and context bloat — an agent cannot tell a transient
 * error from a permanent rule when both come back as "related text".
 *
 * Every write to the procedural store is validated by lib/kb_schema.py (Pydantic).
 * That schema's `enforcement` field is a discriminated union over the three compile
 * targets, so a prose-only "constraint" is not a validation failure — it cannot be
 * expressed. This is pillar 3's admission rule enforced structurally.
 *
 * Python is the single source of truth for the schema deliberately: the same models
 * emit the JSON Schema handed to the analyst, so the model's output space and the
 * enforcement space are the same object.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const SCHEMA_PY = path.join(SCRIPT_DIR, 'kb_schema.py');

let ROOT = path.join(SCRIPT_DIR, '..', '..', 'agents', 'kb');

/** Point the store at a different root (tests, or a per-project KB). */
function configure({ root } = {}) {
  if (root) ROOT = root;
  ensure();
}

const episodesPath = () => path.join(ROOT, 'healing-events.jsonl');
const constraintsPath = () => path.join(ROOT, 'constraints.json');
const archivePath = () => path.join(ROOT, 'constraints.archive.jsonl');
// PILLAR 4 — blast radius. Every synthesis that did NOT become a rule lands here
// with its reason. Without it, a synthesizer that never once produced a valid
// constraint is indistinguishable from a pipeline with nothing to learn — the
// same silent-failure class as the analyst (B30), one layer up.
const quarantinePath = () => path.join(ROOT, 'unmapped-rules.jsonl');

function ensure() {
  fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(constraintsPath())) writeConstraints([]);
  if (!fs.existsSync(episodesPath())) fs.writeFileSync(episodesPath(), '');
}

function python() {
  const venv = path.join(SCRIPT_DIR, '..', '.venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : 'python3';
}

/**
 * Validate against the Pydantic model. Throws with the field-level reason.
 * A validation failure must NEVER result in a partial write — callers validate
 * before touching disk.
 */
function validate(kind, record) {
  const r = spawnSync(python(), [SCHEMA_PY, `validate-${kind}`], {
    input: JSON.stringify(record), encoding: 'utf8',
  });
  if (r.error) throw new Error(`kb-store: cannot run schema validator: ${r.error.message}`);
  let out = {};
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}'); } catch { /* below */ }
  if (r.status !== 0 || out.ok !== true) {
    throw new Error(`kb-store: invalid ${kind} — ${out.detail || r.stderr || 'schema validation failed'}`);
  }
  return true;
}

// ─── Episodic ───────────────────────────────────────────────────────────────

/** Append one immutable episode. Evidence only — never instruction. */
function recordEpisode(ep) {
  ensure();
  const rec = { ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...ep };
  validate('episode', rec);
  fs.appendFileSync(episodesPath(), JSON.stringify(rec) + '\n');
  return rec;
}

/**
 * Record a synthesis that did not enter the procedural store.
 *
 * EVIDENCE, NEVER INSTRUCTION: like the episodic log this is never read back to
 * an agent and is deliberately not reachable from lookup(), so it cannot become a
 * prompt-injection channel by the back door.
 *
 * `outcome` is three-valued in the same discipline used everywhere else here:
 *   declined       the model deliberately refused (NO_CONSTRAINT) — legitimate
 *   no_output      the runner FAILED or returned nothing — broken, not a decision
 *   unparseable    a reply arrived but was not a JSON object
 *   unmapped_rule  parsed, but outside the enforcement whitelist (Pydantic refused)
 * Never write it unvalidated: quarantine is not a bypass around the schema.
 */
function quarantine({ outcome, signature, agent_role, reason, detail, raw }) {
  ensure();
  const rec = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    outcome, signature: signature || null, agent_role: agent_role || null,
    reason: reason || null, detail: detail || null,
    raw: raw ? String(raw).slice(0, 2000) : null,
  };
  fs.appendFileSync(quarantinePath(), JSON.stringify(rec) + '\n');
  return rec;
}

function quarantined() {
  ensure();
  if (!fs.existsSync(quarantinePath())) return [];
  return fs.readFileSync(quarantinePath(), 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function episodes() {
  ensure();
  return fs.readFileSync(episodesPath(), 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ─── Procedural ─────────────────────────────────────────────────────────────

function readConstraints() {
  ensure();
  try { return JSON.parse(fs.readFileSync(constraintsPath(), 'utf8')); }
  catch { return []; }
}

function writeConstraints(list) {
  // Whole-document atomic replace: a torn constraints.json would silently drop
  // enforcement for every rule at once.
  const tmp = constraintsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, constraintsPath());
}

/** Insert or replace a constraint by id. Validates BEFORE any disk write. */
function putConstraint(c) {
  ensure();
  validate('constraint', c);
  const list = readConstraints();
  const i = list.findIndex(x => x.id === c.id);
  if (i >= 0) list[i] = c; else list.push(c);
  writeConstraints(list);
  return c;
}

/**
 * Deterministic lookup. Matches when the signature is equal AND the scope binds:
 * either the role matches exactly, or the constraint is global.
 */
function lookup({ agent_role, signature, phase } = {}) {
  return readConstraints().filter(c =>
    c.status !== 'archived' &&
    c.trigger?.signature === signature &&
    (c.scope?.global === true || c.scope?.agent_role === agent_role) &&
    (!c.trigger?.phase || !phase || c.trigger.phase === phase));
}

// ─── Synthesis: N episodes -> ONE rule (pillar 1) ────────────────────────────

/**
 * Build (or merge into) the single constraint for a (role, signature) pair,
 * citing every episode that motivated it. Re-synthesising merges rather than
 * appending a duplicate — unbounded near-identical rules are how a KB rots.
 */
function synthesize({ agent_role, signature, phase, enforcement, reason, id, ttl_cycles }) {
  ensure();
  const motivating = episodes()
    .filter(e => e.signature === signature && (!agent_role || e.agent_role === agent_role))
    .map(e => e.id).filter(Boolean);

  const existing = lookup({ agent_role, signature, phase })[0];
  const merged = {
    id: existing?.id || id || slug(`${agent_role || 'global'}-${signature}`),
    scope: agent_role ? { agent_role } : { global: true },
    trigger: phase ? { signature, phase } : { signature },
    enforcement,
    reason,
    origin_episodes: Array.from(new Set([...(existing?.origin_episodes || []), ...motivating])),
    created: existing?.created || undefined,
    ttl_cycles: ttl_cycles ?? existing?.ttl_cycles ?? 20,
    cycles_idle: existing?.cycles_idle ?? 0,
    status: 'active',
  };
  Object.keys(merged).forEach(k => merged[k] === undefined && delete merged[k]);
  return putConstraint(merged);
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60) || 'constraint';

module.exports = {
  configure, recordEpisode, episodes, quarantine, quarantined,
  putConstraint, readConstraints, writeConstraints, lookup, synthesize,
  validate, slug,
  _paths: () => ({ episodes: episodesPath(), constraints: constraintsPath(), archive: archivePath() }),
};
