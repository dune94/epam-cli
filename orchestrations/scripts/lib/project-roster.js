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
  // AN UNUSABLE ENTRY IS REFUSED, NOT SKIPPED. The completeness check ignores non-strings, so a
  // canonical entry that is an object or empty would be dropped from the roster in silence — and
  // the agent it names would throw at whichever invocation first reached for it, mid-run, long
  // after the roster was accepted. Canonical is all strings today; this is what keeps it so.
  const unusable = Object.keys(parsed).filter((k) => !names.includes(k));
  if (unusable.length) {
    throw new Error(
      `[roster] canonical entries are not usable personas: ${unusable.join(', ')}. Every entry is `
      + 'an agent\'s persona text; one that is empty or not a string would be dropped from the '
      + 'roster silently and fail at the invocation that needed it.');
  }
  fs.mkdirSync(path.dirname(canonicalCopyPath(logDir)), { recursive: true });
  fs.writeFileSync(canonicalCopyPath(logDir), raw, 'utf8');
  return canonicalCopyPath(logDir);
}

// DECLARED IN THE REGISTRY, not here. This and agent-roster.js each held the list and they
// disagreed — 'seam' validated in one and was an unrecognised kind in the other. See
// lib/agent-kinds.js.
const { agentKinds, kindMembership } = require('./agent-kinds.js');

/**
 * HOW THIS PROJECT GETS ITS ROSTER — DECLARED, NOT INFERRED.
 *
 *   derive     (default) an agent specialises canonical for this project, and it is reviewed.
 *   canonical  canonical IS the roster: personas copied verbatim, provenance recorded, no
 *              agent call and nothing to review.
 *
 * WHY THE SECOND MODE EXISTS. roster-specialiser is the most expensive seam in a run — top
 * ladder, 65536 output tokens, up to 250 turns. A rehearsal project does not need specialised
 * personas, and paying for them to rehearse plumbing pays for the wrong thing.
 *
 * WHAT IT IS NOT. 862ca17 stopped EPAM_SKIP_AGENT_MINT from silently ALSO skipping roster
 * derivation, because skipping meant "run with no identities". This installs identities
 * EXPLICITLY and holds them to the same contract; it only removes the model call. An unknown
 * value is refused rather than treated as the default: a typo would quietly buy a full
 * specialisation, or quietly stop buying one.
 */
function readRosterMode(projectConfigDir) {
  const KNOWN = ['derive', 'canonical'];
  let declared = '';
  try {
    const f = path.join(projectConfigDir || '', 'llm-settings.json');
    if (fs.existsSync(f)) declared = String(JSON.parse(fs.readFileSync(f, 'utf8')).rosterMode || '').trim();
  } catch { /* an unreadable settings file is not a declaration */ }
  if (!declared) return 'derive';
  if (!KNOWN.includes(declared)) {
    throw new Error(
      `[roster] rosterMode '${declared}' is not one of ${KNOWN.join('|')}. Refusing to guess: `
      + 'treating an unknown value as the default would either buy a full specialisation nobody '
      + 'asked for, or silently stop buying one that was wanted.');
  }
  return declared;
}

/** Canonical, in the shape the roster contract requires. Deterministic — no model involved. */
function rosterFromCanonical(canonical) {
  const membership = kindMembership();
  const kindOf = (name) => {
    for (const [kind, names] of Object.entries(membership || {})) {
      if (Array.isArray(names) && names.includes(name)) return kind;
    }
    return 'seam';
  };
  const agents = {};
  for (const [name, persona] of Object.entries(canonical)) {
    if (typeof persona !== 'string' || !persona.trim()) continue;
    agents[name] = {
      persona,
      kind: kindOf(name),
      // ITS OWN ANCESTOR. Copying canonical means the ancestor IS the entry, and the digest
      // records that nothing was changed — the same provenance a derived roster carries.
      ancestor: name,
      derivedFromSha256: personaDigest(persona),
      rationale: 'canonical persona, adopted verbatim: this project declares rosterMode=canonical',
    };
  }
  return { agents };
}

/**
 * THE AGENTS THIS PROJECT MINTED, added to a canonical roster.
 *
 * rosterMode=canonical means "do not pay the SPECIALISER to rewrite canonical personas". It does
 * not mean "throw away the mint": the mint is a separate, earlier, cheaper step, and what it
 * produces — this project's implementers and per-codeline investigators — exists nowhere in
 * canonical, because those roles are project-specific by nature.
 *
 * Discarding them made a project declaring this mode unrunnable. On 2026-08-26 mock3's mint
 * created fare-schedule-engineer, registered it, role assignment gave it both stories, and the
 * roster check refused every assignment: "2 assignment(s) name a role that is not in the settled
 * roster". The roster held 54 agents, all kind "seam", and no implementer at all.
 *
 * A minted agent is its OWN ancestor with a digest over its own brief: it was not derived from a
 * canonical persona, and recording one it never had would be a false provenance claim. Canonical
 * wins a name collision — the mint must not shadow a process role.
 */
function withMintedAgents(roster, projectConfigDir) {
  if (!projectConfigDir || !roster || !roster.agents) return roster;
  let minted = {};
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(projectConfigDir, 'agent-profiles.json'), 'utf8'));
    minted = (doc && doc.profiles) || doc || {};
  } catch { return roster; }              // a project with no minted briefs adds none

  // eslint-disable-next-line global-require
  const { kindOfAgent } = require('./agent-roster.js');
  for (const [name, persona] of Object.entries(minted)) {
    if (typeof persona !== 'string' || !persona.trim()) continue;
    if (roster.agents[name]) continue;    // canonical wins; the mint never shadows a process role
    let kind = '';
    try { kind = kindOfAgent(name, projectConfigDir); } catch { kind = ''; }
    if (!kind) continue;                  // an agent in no registry has no declared kind to record
    roster.agents[name] = {
      persona,
      kind,
      ancestor: name,
      derivedFromSha256: personaDigest(persona),
      rationale: 'minted for this project and adopted verbatim: this project declares '
        + 'rosterMode=canonical, which skips the specialiser, not the mint',
    };
  }
  return roster;
}

/** Seam names the registry declares. Read once — this is asked for every entry in the roster. */
let _declaredSeams;
function declaredSeams() {
  if (_declaredSeams) return _declaredSeams;
  _declaredSeams = new Set();
  try {
    const reg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json'), 'utf8'));
    (function walk(o) {
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object') {
          if (v.ladder || v.reasoningEffort || v._what) _declaredSeams.add(k);
          walk(v);
        }
      }
    }((reg && reg.profiles) || {}));
  } catch { /* an unreadable registry declares nothing, and every binding then fails by name */ }
  return _declaredSeams;
}

/**
 * Check ONE produced entry against the ancestry contract.
 *
 * Deliberately shallow on content: this asks whether the entry is WELL-FORMED and ANCESTRED, not
 * whether its prose is good — that is the reviewer's job, and it has the codeline to check
 * against. Conflating the two gives a mechanical check opinions it cannot support.
 *
 * @returns {{ok: boolean, reason: string}}
 */
/**
 * The seam this agent's NAME resolves to, or '' when nothing does.
 *
 * Deliberately THE SAME resolver the runtime uses. mint-agents-step.js says why: "two
 * implementations of 'which seam is this agent' would be two answers to one question".
 */
function derivedSeamFor(name) {
  try {
    // eslint-disable-next-line global-require
    const { resolveSeam } = require('./seam-invocation.js');
    return resolveSeam(name, path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json'),
      { ignoreXref: true }) || '';
  } catch { return ''; }
}

/**
 * Is this agent registered as one of THIS PROJECT's own — an implementer or an investigator?
 *
 * Read from the kind registries the mint writes, which is the same source kindOfAgent uses. A
 * name that is in none of them is not a minted agent, whatever its roster entry claims.
 */
function isRegisteredProjectAgent(name) {
  if (!name) return false;
  try {
    // eslint-disable-next-line global-require
    const { kindOfAgent } = require('./agent-roster.js');
    const dir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
    return Boolean(dir && kindOfAgent(name, dir));
  } catch { return false; }
}

function checkEntry(name, entry, canonical) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof entry.persona !== 'string' || !entry.persona.trim()) {
    return { ok: false, reason: 'no persona' };
  }
  if (!agentKinds().includes(entry.kind)) {
    return { ok: false, reason: `kind must be one of ${agentKinds().join('|')} (got ${JSON.stringify(entry.kind)})` };
  }
  // ANCESTRY IS MANDATORY, minted agents included. Without it an agent has no ladder, no tool
  // grant and no output contract, and something has to invent them — which is how the engine
  // registry came to be written during a run.
  if (typeof entry.ancestor !== 'string' || !entry.ancestor.trim()) {
    return { ok: false, reason: 'no canonical ancestor named' };
  }
  // AN AGENT THIS PROJECT MINTED DESCENDS FROM NOTHING IN CANONICAL, AND SAYS SO.
  //
  // The rule above is right for a DERIVED agent: it names the canonical role whose ladder, tool
  // grant and output contract it inherits. A minted agent has no such ancestor — it is a role
  // this project needed and canonical never had — so its honest provenance is itself.
  //
  // This used to pass by accident: until 2026-08-22 (ba9cee7) the mint wrote into the engine's
  // profiles.json, so minted agents WERE in the canonical copy. Isolating that file — one
  // project's agents were reaching another's roster — removed the accident and nothing replaced
  // it, so every minted agent became a contract violation. mock3 run 7: "ancestor
  // 'fare-rules-engineer' is not in canonical".
  //
  // Stated as an exemption rather than bypassed by adding these agents after the check: a
  // contract that says every agent needs a canonical ancestor, while some quietly do not, is a
  // contract nobody can rely on. Registration is what earns it — an agent claiming self-ancestry
  // without being in a kind registry is still refused, so this cannot become "anything may skip
  // the check".
  const _selfMinted = entry.ancestor === name && isRegisteredProjectAgent(name);
  if (!_selfMinted) {
    if (!Object.prototype.hasOwnProperty.call(canonical, entry.ancestor)) {
      return { ok: false, reason: `ancestor '${entry.ancestor}' is not in canonical` };
    }
    if (entry.derivedFromSha256 !== personaDigest(canonical[entry.ancestor])) {
      return { ok: false, reason: `provenance digest does not match ancestor '${entry.ancestor}'` };
    }
  } else if (entry.derivedFromSha256 !== personaDigest(entry.persona)) {
    // The digest still has to be real: self-ancestry means the digest is over its OWN brief, so a
    // changed brief with a stale digest is caught exactly as it is for a derived agent.
    return { ok: false, reason: `provenance digest does not match its own brief for minted '${name}'` };
  }
  // A SEAM BINDING IS CHECKED WHERE THE ROSTER IS WRITTEN, not where it is first used. A seam the
  // registry does not declare would otherwise pass review, land on disk, and throw at whichever
  // invocation happened to reach that agent — mid-run, after the roster looked accepted.
  if (entry.seam !== undefined) {
    if (typeof entry.seam !== 'string' || !entry.seam.trim()) {
      return { ok: false, reason: 'seam is present but empty — omit it, or name one' };
    }
    if (!declaredSeams().has(entry.seam)) {
      // THE RESOLVER ALREADY KNOWS. An agent's seam is derivable from its NAME — the registry's
      // seamPatterns map `(^|-)engineer$` to story-writer and carry `kind: "implementer"` while
      // doing it. So a `seam` field is a second answer to a question already settled, and this
      // check failed whole mints over which FIELD a correct word sat in.
      //
      // Live 2026-08-31, metrolinx AMSD-1919: two agents minted, roster review sound, then
      // "seam 'implementer' is not declared in the registry" — where `implementer` is the very
      // kind the matching pattern declares, and both names resolved cleanly.
      const derived = derivedSeamFor(name);
      // Naming the KIND is not an invented seam: it is the right word in the wrong field, and the
      // run must not die for it while the name resolves on its own.
      if (agentKinds().includes(entry.seam) && derived) return { ok: true, reason: '' };
      // Otherwise refused — but a refusal the producer cannot act on earns the same answer again,
      // because the retry re-asks the same model with the same brief.
      return {
        ok: false,
        reason: `seam '${entry.seam}' is not declared in the registry`
          + (derived
            ? ` — this agent's name resolves to '${derived}'; use that, or omit the field`
            : ' — omit the field and let the resolver derive it from the name'),
      };
    }
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
  // DECLARED MODE, DECIDED BEFORE ANY MODEL TIME IS SPENT.
  const mode = readRosterMode(projectConfigDir);
  if (mode === 'canonical') {
    const roster = withMintedAgents(rosterFromCanonical(canonical), projectConfigDir);
    // HELD TO THE SAME CONTRACT. A cheaper path that skipped the check would be a second,
    // unvalidated way for a roster to reach disk — which is the shape of every defect this
    // library exists to prevent.
    const contract = checkRoster(roster, canonical);
    if (!contract.ok) {
      throw new Error(`[roster] canonical does not satisfy the roster contract: ${contract.reason}`);
    }
    fs.writeFileSync(outPath, JSON.stringify(roster, null, 2));
    const _minted = Object.values(roster.agents).filter((a) => a.rationale && a.rationale.startsWith('minted')).length;
    log(`[roster] rosterMode=canonical — ${Object.keys(roster.agents).length} persona(s) adopted verbatim`
        + `${_minted ? ` (${_minted} minted for this project)` : ''}, no specialiser call`);
    return roster;
  }

  let lastReason = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A fresh start each attempt: a retry must not inherit half of the previous answer, or a
    // roster that failed once can pass by accumulation.
    try { fs.unlinkSync(outPath); } catch { /* absent is the normal case */ }

    // THE AGENT WRITES THE FILE, with its own tools. The pipeline hands it the canonical copy
    // and a destination and then judges the artefact — it does not compose the roster itself,
    // because deciding each persona's shape is the agent's work, not the pipeline's.
    // A RUNNER FAILURE IS AN ATTEMPT, NOT THE END. Unguarded, a throw here propagated straight
    // out and killed the stage having used NONE of its three attempts — which is what
    // "prompt runner exited with code 1" did on 2026-08-23, after the previous attempt had already
    // produced a contract-passing roster. Declaring `attempts: 3` and spending one on a transient
    // is the same as declaring one.
    try {
      await produce({ canonicalCopyPath: copyPath, outPath, attempt, refusal: lastReason });
    } catch (e) {
      lastReason = `the specialiser call failed: ${(e && e.message) || e}`;
      log(`[roster] attempt ${attempt}/${attempts} CALL FAILED: ${lastReason}`);
      try { fs.unlinkSync(outPath); } catch { /* nothing to remove */ }
      continue;
    }

    if (!fs.existsSync(outPath)) {
      lastReason = `the agent wrote no roster at ${outPath}`;
      log(`[roster] attempt ${attempt}/${attempts} REFUSED: ${lastReason}`);
      // SELF-HEAL, WITH THE ROSTER THE AGENT ACTUALLY WROTE. Reading it back is the only way
      // the analyst can see WHY the contract failed rather than which clause reported it.
      try {
        let _produced = '';
        try { _produced = fs.readFileSync(outPath, 'utf8'); } catch { _produced = ''; }
        // eslint-disable-next-line global-require
        const _sh = require('./self-heal.js').selfHeal({
          agent: 'roster-specialiser', reason: lastReason, output: _produced, logDir,
    model: process.env.EPAM_MODEL || '', provider: process.env.AI_PROVIDER || '',
    projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR || '',
        });
        if (_sh.rc === 2) log(`[roster] self-heal analyst FAILED — attempt ${attempt + 1} has no corrective`);
      } catch { /* a diagnostic must never fail the run it is diagnosing */ }
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
      // THE REVIEW RETRIES AGAINST THE SAME ROSTER. An inner loop, because `continue` on the outer
      // one re-runs the producer — which is the very thing that must not happen when the artefact
      // is not implicated. Live 2026-08-23 that cost three specialisations for one bad reviewer.
      let approved = false;
      let reviewReason = '';
      for (let r = 1; r <= attempts; r++) {
        // A THROWING REVIEWER IS A FAILED REVIEW, not a failed roster and not a dead stage. The
        // mint's own wrapper catches this today, but a library that depends on its caller to be
        // careful is one caller away from the bug it was written to prevent.
        let verdict;
        try {
          verdict = await review({ roster, canonical, rosterPath: outPath, canonicalPath: copyPath });
        } catch (e) {
          verdict = { verdict: 'review_failed', reason: `the review call failed: ${(e && e.message) || e}` };
        }

        const _cls = classifyReviewVerdict(verdict);
        if (_cls.outcome === 'approved') { approved = true; break; }

        // A REVIEW THAT FAILED IS NOT A ROSTER THAT FAILED. 'nothing_to_review' means the reviewer
        // did not look — it returned its own plan, once — and the schema distinguishes that from
        // examined-and-defective on purpose. Retry the judge; leave the artefact alone.
        if (_cls.outcome === 'review_failed' || _cls.outcome === 'unrecognised') {
          reviewReason = verdict.reason || _cls.reason;
          log(`[roster] review did not examine the roster (${r}/${attempts}): ${reviewReason}`);
          continue;
        }

        // Examined, and found wanting. THAT implicates the roster.
        // The findings themselves, not "[object Object]": the next attempt can only fix what it
        // is told, and joining an array of objects tells it nothing.
        lastReason = _cls.reason || 'review returned no verdict';
        log(`[roster] attempt ${attempt}/${attempts} REJECTED by review: ${lastReason}`);
        break;
      }

      if (!approved) {
        try { fs.unlinkSync(outPath); } catch { /* nothing to remove */ }
        if (reviewReason && !lastReason) {
          throw new Error(
            `[roster] the roster review never examined the roster in ${attempts} attempt(s): `
            + `${reviewReason}. The roster satisfied its contract; the review is what failed, and `
            + 'an unreviewed roster is not one to run agents from.');
        }
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
  if (!agentKinds().includes(kind)) throw new Error(`[roster] unknown kind '${kind}' (expected ${agentKinds().join('|')})`);
  const doc = loadRoster(projectConfigDir);
  return Object.keys(doc.agents).filter((n) => doc.agents[n] && doc.agents[n].kind === kind).sort();
}


/**
 * classifyReviewVerdict — WHAT THE REVIEWER ACTUALLY SAID, MAPPED TO WHAT THE GATE DOES.
 *
 * This gate accepted `verdict === 'approved'` and retried on `'review_failed'`. The reviewer emits
 * neither: its prompt declares `sound` and `defects_found`, and the schema allows
 * `nothing_to_review`. With no overlap, every outcome fell through to rejection — live 2026-09-01
 * a review returning {"verdict":"sound"} with zero findings had its roster discarded, three
 * attempts ran, the mint failed and the run halted. Eighteen model calls whose answer could not be
 * acted on whatever it was.
 *
 *   sound                        → approved
 *   defects_found, no blocking   → approved  (advisory findings are notes, not blockers)
 *   defects_found, blocking      → rejected  (the reason carries the findings to the next attempt)
 *   nothing_to_review            → review_failed (the JUDGE did not look; the roster is not at fault)
 *   anything else                → unrecognised (never an approval, and it says so)
 */
function classifyReviewVerdict(verdict) {
  const v = verdict && typeof verdict === 'object' ? verdict.verdict : undefined;
  const findings = (verdict && Array.isArray(verdict.findings)) ? verdict.findings : [];
  const blocking = findings.filter((f) => f && f.severity === 'blocking');
  const describe = (list) => list
    .map((f) => `${f.agent || 'roster'}: ${f.claim || f.found || f.remedy || 'no detail given'}`)
    .join('; ');

  if (v === 'sound') return { outcome: 'approved', reason: '' };
  if (v === 'defects_found') {
    return blocking.length
      ? { outcome: 'rejected', reason: describe(blocking) }
      : { outcome: 'approved', reason: findings.length ? describe(findings) : '' };
  }
  if (v === 'nothing_to_review') {
    return { outcome: 'review_failed', reason: 'the reviewer did not examine the roster' };
  }
  return {
    outcome: 'unrecognised',
    reason: `the reviewer answered '${String(v)}', which this gate does not recognise — `
      + 'its declared vocabulary is sound | defects_found | nothing_to_review',
  };
}

module.exports = {
  classifyReviewVerdict,
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
  agentKinds,
};
