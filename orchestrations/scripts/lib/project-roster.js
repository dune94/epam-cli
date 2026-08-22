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
  // THE SET MUST BE COMPLETE. Whatever canonical holds, the roster holds — no subset logic
  // anywhere. The moment a subset is allowed something must decide which agents matter, and a
  // fallback to the engine layer has to exist for the rest; that fallback is what gave a
  // metrolinx review a persona describing this repository.
  for (const n of Object.keys(canonical)) {
    if (typeof canonical[n] !== 'string' || !canonical[n].trim()) continue;
    if (!Object.prototype.hasOwnProperty.call(entries, n)) bad.push(`${n}: in canonical, absent from the roster`);
  }
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
  canonicalPath, logDir, projectConfigDir, produce, review, attempts = 3, log = () => {},
}) {
  if (typeof produce !== 'function') throw new Error('[roster] produce is required');
  const copyPath = copyCanonicalForRun(canonicalPath, logDir);
  const canonical = JSON.parse(fs.readFileSync(copyPath, 'utf8'));
  const outPath = projectRosterPath(projectConfigDir);

  let lastReason = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A fresh start each attempt: a retry must not inherit half of the previous answer, or a
    // roster that failed once can pass by accumulation.
    try { fs.unlinkSync(outPath); } catch { /* absent is the normal case */ }

    // THE AGENT WRITES THE FILE, with its own tools. The pipeline hands it the canonical copy
    // and a destination and then judges the artefact — it does not compose the roster itself,
    // because deciding each persona's shape is the agent's work, not the pipeline's.
    await produce({ canonicalCopyPath: copyPath, outPath, attempt, refusal: lastReason });

    if (!fs.existsSync(outPath)) {
      lastReason = `the agent wrote no roster at ${outPath}`;
      log(`[roster] attempt ${attempt}/${attempts} REFUSED: ${lastReason}`);
      continue;
    }
    let roster;
    try { roster = JSON.parse(fs.readFileSync(outPath, 'utf8')); }
    catch (e) {
      lastReason = `the roster is not valid JSON: ${e && e.message}`;
      log(`[roster] attempt ${attempt}/${attempts} REFUSED: ${lastReason}`);
      try { fs.unlinkSync(outPath); } catch { /* nothing to remove */ }
      continue;
    }

    const contract = checkRoster(roster, canonical);
    if (!contract.ok) {
      lastReason = contract.reason;
      log(`[roster] attempt ${attempt}/${attempts} REFUSED: ${contract.reason}`);
      try { fs.unlinkSync(outPath); } catch { /* nothing to remove */ }
      continue;
    }

    // REVIEWED AGAINST BOTH. With only the roster a reviewer can judge plausibility; falsifying
    // "is this ancestor close" and "was inherited structure quietly changed" needs the source.
    if (typeof review === 'function') {
      const verdict = await review({ roster, canonical, rosterPath: outPath, canonicalPath: copyPath });
      if (!verdict || verdict.verdict !== 'approved') {
        lastReason = (verdict && (verdict.reason || (verdict.findings || []).join('; ')))
          || 'review returned no verdict';
        log(`[roster] attempt ${attempt}/${attempts} REJECTED by review: ${lastReason}`);
        try { fs.unlinkSync(outPath); } catch { /* nothing to remove */ }
        continue;
      }
    }
    log(`[roster] accepted ${Object.keys(roster.agents).length} agent(s)`);
    return roster;
  }
  throw new Error(`[roster] could not produce an accepted roster in ${attempts} attempt(s). Last: ${lastReason}`);
}

/**
 * Load a project's roster. REFUSES when it is not there.
 *
 * There is no fallback to the engine layer, deliberately. That default existed at six call sites
 * and is the path that gave a client-codeline review a persona describing this repository — and
 * it would survive every test written about the roster, because it only fires when resolution
 * fails, which is exactly the case the design exists to prevent.
 *
 * The error names the project dir and does NOT name the shared file: an error message that
 * suggests a workaround gets taken.
 */
function loadRoster(projectConfigDir) {
  if (!projectConfigDir) {
    throw new Error('[roster] no project config dir given — an agent\'s identity has one source and this is not it');
  }
  const file = projectRosterPath(projectConfigDir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    throw new Error(
      `[roster] no project roster at ${file}. It is produced by the roster-specialiser every run; `
      + 'a run without one has no agent identities, and there is nothing to fall back to.');
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    throw new Error(`[roster] project roster is not valid JSON (${file}): ${e && e.message}`);
  }
  if (!doc || typeof doc.agents !== 'object' || !doc.agents) {
    throw new Error(`[roster] project roster declares no agents (${file})`);
  }
  return doc;
}

/**
 * One agent's persona. REFUSES for an agent the roster does not carry.
 *
 * Returning '' here would be the defect this replaces: the consumers all read
 * `jq -r '.["review-agent"] // ""'`, so a missing entry became an empty system prompt and an
 * agent answered from nothing. An empty persona is indistinguishable from a terse one.
 */
function personaFor(agentName, projectConfigDir) {
  const doc = loadRoster(projectConfigDir);
  const entry = doc.agents[agentName];
  if (!entry || typeof entry.persona !== 'string' || !entry.persona.trim()) {
    throw new Error(
      `[roster] '${agentName}' has no persona in this project's roster. Every canonical agent is `
      + 'specialised into it, so an absence here is a defect in the roster, not a reason to guess.');
  }
  return entry.persona;
}

/**
 * Every agent of a kind — 'implementer', 'investigator', 'seam'.
 *
 * This answers the write perimeter's question, which used to need its own registry file. It
 * refuses on a missing roster like everything else: a perimeter reading an empty implementer list
 * would lock the codeline, and one reading a defaulted list would open it. Neither silently.
 */
function agentsOfKind(kind, projectConfigDir) {
  if (!KINDS.includes(kind)) throw new Error(`[roster] unknown kind '${kind}' (expected ${KINDS.join('|')})`);
  const doc = loadRoster(projectConfigDir);
  return Object.keys(doc.agents).filter((n) => doc.agents[n] && doc.agents[n].kind === kind).sort();
}

module.exports = {
  buildProjectRoster,
  loadRoster,
  personaFor,
  agentsOfKind,
  copyCanonicalForRun,
  canonicalCopyPath,
  projectRosterPath,
  personaDigest,
  checkEntry,
  checkRoster,
  structureFor,
  KINDS,
};
