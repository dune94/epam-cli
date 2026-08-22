#!/usr/bin/env node
/**
 * THE PROJECT ROSTER — one file that says who this project's agents are.
 *
 * Operator mandate, 2026-08-22: "canonical can never be overridden. during a run, a copy is made
 * from canonical. then agentically a project level roster is produced as an output and reviewed."
 *
 * Before this, agent identity was spread across five files in two layers with no owner. A project
 * DEFINED two agents (agent-profiles.json) and INHERITED twenty-five from a roster shared with the
 * engine, which it could not override — so a metrolinx review ran five times with a persona
 * describing this repository. Names were registered in two more files, wiring in a fourth, and the
 * mint wrote into the engine layer on every run because there was nowhere else to put them.
 *
 * THE SHAPE, mirroring the prompt layer deliberately — immutable source, agentic derivation,
 * review gate — because that is a pattern this pipeline already understands:
 *
 *   profiles.canonical.json   immutable. Never written. Never overridden. Belongs to no project.
 *          |  copied to $LOG_DIR for the run
 *          v
 *   an agent specialises each entry for THIS project, using its tools
 *          |
 *          v
 *   projects/<project>/roster.json   the project's own roster — an OUTPUT of the run
 *          |
 *          v
 *   reviewed against BOTH itself and canonical, on the producer's own rung
 *
 * EVERY ENTRY NAMES AN ANCESTOR. Minted agents included — an agent invented from nothing has no
 * ladder, no tool grant and no output contract, which is exactly why the mint used to write the
 * engine's invocation registry. The ancestor supplies STRUCTURE; the project supplies CONTENT.
 * Content is free to diverge and is never compared against canonical; `derivedFromSha256` records
 * what it diverged from, so staleness is arithmetic rather than inspection.
 *
 * REGENERATED EVERY RUN. A stored artifact that only refreshes when something happens to refresh
 * it is the two-clock problem that left 40 project prompts stale against their templates.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Where the run's working copy of canonical lives. Run-scoped, never beside the output. */
function canonicalCopyPath(logDir) {
  return path.join(String(logDir || ''), 'roster-canonical-copy.json');
}

/** The project's own roster — the only thing consumers read. */
function projectRosterPath(projectConfigDir) {
  return path.join(String(projectConfigDir || ''), 'roster.json');
}

/** The digest convention, in one place: provenance is over the ancestor's TEXT. */
function personaDigest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * Copy canonical into the run. Returns the copy's path.
 *
 * A copy, not a read-through: the specialising agent works against a snapshot, so a canonical
 * edited mid-run cannot change what half the roster derived from.
 */
function copyCanonicalForRun(canonicalPath, logDir) {
  const raw = fs.readFileSync(canonicalPath, 'utf8');
  const parsed = JSON.parse(raw);
  const names = Object.keys(parsed).filter((k) => typeof parsed[k] === 'string' && parsed[k].trim());
  if (!names.length) throw new Error(`[roster] canonical has no usable entries: ${canonicalPath}`);
  fs.mkdirSync(path.dirname(canonicalCopyPath(logDir)), { recursive: true });
  fs.writeFileSync(canonicalCopyPath(logDir), raw, 'utf8');
  return canonicalCopyPath(logDir);
}

const KINDS = ['implementer', 'investigator', 'seam'];

/**
 * Check ONE produced entry against the ancestry contract.
 *
 * Deliberately shallow on content: this asks whether the entry is WELL-FORMED and ANCESTRED, not
 * whether its prose is good — that is the reviewer's job, and it has the codeline to check
 * against. Conflating the two gives a mechanical check opinions it cannot support.
 *
 * @returns {{ok: boolean, reason: string}}
 */
function checkEntry(name, entry, canonical) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof entry.persona !== 'string' || !entry.persona.trim()) {
    return { ok: false, reason: 'no persona' };
  }
  if (!KINDS.includes(entry.kind)) {
    return { ok: false, reason: `kind must be one of ${KINDS.join('|')} (got ${JSON.stringify(entry.kind)})` };
  }
  // ANCESTRY IS MANDATORY, minted agents included. Without it an agent has no ladder, no tool
  // grant and no output contract, and something has to invent them — which is how the engine
  // registry came to be written during a run.
  if (typeof entry.ancestor !== 'string' || !entry.ancestor.trim()) {
    return { ok: false, reason: 'no canonical ancestor named' };
  }
  if (!Object.prototype.hasOwnProperty.call(canonical, entry.ancestor)) {
    return { ok: false, reason: `ancestor '${entry.ancestor}' is not in canonical` };
  }
  if (entry.derivedFromSha256 !== personaDigest(canonical[entry.ancestor])) {
    return { ok: false, reason: `provenance digest does not match ancestor '${entry.ancestor}'` };
  }
  return { ok: true, reason: '' };
}

/** Every entry's verdict, in one pass. Names offenders — a bare count cannot be acted on. */
function checkRoster(roster, canonical) {
  const entries = (roster && roster.agents) || {};
  const names = Object.keys(entries);
  if (!names.length) return { ok: false, reason: 'roster declares no agents', bad: [] };
  const bad = [];
  for (const n of names) {
    const v = checkEntry(n, entries[n], canonical);
    if (!v.ok) bad.push(`${n}: ${v.reason}`);
  }
  return { ok: bad.length === 0, reason: bad.join('; '), bad };
}

/**
 * Resolve an agent's STRUCTURE. Never from the roster entry — from its ancestor's seam profile.
 *
 * This is what makes ancestry load-bearing rather than decorative: a project may say who its
 * reviewer IS, but a ladder, a tool grant and an output contract are pipeline architecture. The
 * ladder still owns iteration budgets; the agent only names which one it is on, by inheritance.
 */
function structureFor(name, roster, registry) {
  const entry = ((roster && roster.agents) || {})[name];
  if (!entry) return null;
  const profiles = (registry && registry.profiles) || {};
  const direct = profiles[name];
  const viaAncestor = profiles[entry.ancestor];
  const src = direct || viaAncestor;
  if (!src) return null;
  return {
    from: direct ? name : entry.ancestor,
    ladder: src.ladder,
    toolGrant: src.toolGrant,
    reasoningEffort: src.reasoningEffort,
    maxOutputTokens: src.maxOutputTokens,
    timeoutSecs: src.timeoutSecs,
  };
}

/**
 * Build the project roster.
 *
 * @param {object} o
 *   canonicalPath   the immutable base
 *   logDir          where the run's copy is written
 *   projectConfigDir where roster.json is written
 *   specialise      async ({name, canonicalPersona}) => {persona, kind, ancestor}
 *                   the AGENT. Given one canonical entry, returns this project's version.
 *   review          async ({roster, canonical}) => {verdict, findings}
 *                   given BOTH, so it can falsify rather than assess plausibility
 *   attempts        retries per roster, on the ladder
 *   log             progress sink
 *
 * FAILURE IS TOTAL. A roster that fails its contract is never written: a half-written roster is
 * a run whose agents are partly nobody.
 */
async function buildProjectRoster({
  canonicalPath, logDir, projectConfigDir, specialise, review, attempts = 3, log = () => {},
}) {
  if (typeof specialise !== 'function') throw new Error('[roster] specialise is required');
  const copyPath = copyCanonicalForRun(canonicalPath, logDir);
  const canonical = JSON.parse(fs.readFileSync(copyPath, 'utf8'));
  const names = Object.keys(canonical).filter((k) => typeof canonical[k] === 'string' && canonical[k].trim());

  let lastReason = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const agents = {};
    for (const name of names) {
      const produced = await specialise({
        name, canonicalPersona: canonical[name], attempt, refusal: lastReason,
      });
      if (!produced) continue;
      // PROVENANCE IS THE BUILDER'S FACT, NOT THE AGENT'S CLAIM. This entry was derived from
      // canonical[name] — that is what happened, whatever the specialiser says about it. Taking
      // the agent's word here let an empty ancestor fall through a `||` to the same value, so a
      // failure to name one was indistinguishable from not being asked.
      //
      // A MINTED agent is the opposite case: nothing derived it, so it MUST name an ancestor and
      // there is no default to fall back on. That is where the contract does its work.
      agents[name] = {
        persona: produced.persona,
        kind: produced.kind,
        ancestor: name,
        derivedFromSha256: personaDigest(canonical[name]),
      };
    }
    for (const [name, extra] of Object.entries((await specialiseMinted(specialise, canonical)) || {})) {
      agents[name] = extra;
    }

    const roster = { _what: "This project's agents. Derived from canonical, reviewed, regenerated every run.", agents };
    const contract = checkRoster(roster, canonical);
    if (!contract.ok) {
      lastReason = contract.reason;
      log(`[roster] attempt ${attempt}/${attempts} REFUSED: ${contract.reason}`);
      continue;
    }
    if (typeof review === 'function') {
      const verdict = await review({ roster, canonical });
      if (!verdict || verdict.verdict !== 'approved') {
        lastReason = (verdict && (verdict.reason || (verdict.findings || []).join('; '))) || 'review returned no verdict';
        log(`[roster] attempt ${attempt}/${attempts} REJECTED by review: ${lastReason}`);
        continue;
      }
    }
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(projectRosterPath(projectConfigDir), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
    log(`[roster] wrote ${Object.keys(agents).length} agent(s)`);
    return roster;
  }
  throw new Error(`[roster] could not produce an accepted roster in ${attempts} attempt(s). Last: ${lastReason}`);
}

/** Hook for agents this project invents. Returns {} unless the specialiser offers them. */
async function specialiseMinted(specialise, canonical) {
  if (typeof specialise.minted !== 'function') return {};
  const extra = await specialise.minted({ canonical });
  const out = {};
  for (const [name, e] of Object.entries(extra || {})) {
    out[name] = {
      persona: e.persona,
      kind: e.kind,
      ancestor: e.ancestor,
      derivedFromSha256: personaDigest(canonical[e.ancestor] || ''),
    };
  }
  return out;
}

module.exports = {
  buildProjectRoster,
  copyCanonicalForRun,
  canonicalCopyPath,
  projectRosterPath,
  personaDigest,
  checkEntry,
  checkRoster,
  structureFor,
  KINDS,
};
