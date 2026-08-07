/**
 * agent-roster — merge minted project agents into the roster, additively.
 *
 * WHY THIS EXISTS. `proposeAgents()` has minted project-specific engineering roles since
 * the first commit, but only from the interactive `epam new` scaffold path. The brownfield
 * Jira pipeline never called it, so no client codeline ever had a role minted for it and
 * every ticket fell through to a hardcoded literal in synthesize-prd-from-jira.js. The
 * roster a client codeline actually ran with was epam-cli's OWN first-commit roster.
 *
 * Two rules govern the merge, and both exist because their failure mode is SILENT:
 *
 *  1. ADDITIVE ONLY. FIXED_AGENT_ROLES are the canonical generic core. A proposal is an
 *     LLM suggestion; asked for "project-specific roles" it will occasionally return a
 *     name that collides with one. An overwritten review-agent still has a profile entry
 *     and still gets invoked — it simply reviews with the wrong brief. Nothing errors.
 *  2. CONVERGENT. Re-running the mint must not churn an existing role's prompt. Profiles
 *     accumulate skill notes across runs (claude.sh appends to `.[$role]`), so rewriting
 *     an existing entry silently discards everything that agent has learned.
 *
 * WIRING. A role that exists only as a name is a role nothing can invoke. The seams bind
 * generically — `jq -r --arg role '.[$role] // ""'` for instructions and skill notes,
 * `KB-${story_role}.md` for the persistent skills store — so a minted role becomes fully
 * operational the moment BOTH surfaces exist. Tools come from the invocation profile,
 * which is keyed by seam rather than by role, so a minted agent inherits the tools of
 * whatever seam runs it and needs no per-role tool wiring to function.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The canonical core, read from the SDK so there is exactly one definition of it.
// A local copy here would drift the moment a role is added to prdTypes.ts.
function protectedRoles() {
  try {
    const sdk = require(path.join(__dirname, '..', '..', '..', 'dist', 'sdk.js'));
    if (Array.isArray(sdk.FIXED_AGENT_ROLES) && sdk.FIXED_AGENT_ROLES.length) {
      return new Set(sdk.FIXED_AGENT_ROLES);
    }
  } catch (_) { /* fall through to the loud failure below */ }
  // NOT an empty set. Failing open here would silently disable protection entirely and
  // let a proposal overwrite the whole canonical core on the one run the build was stale.
  throw new Error(
    '[agent-roster] cannot read FIXED_AGENT_ROLES from dist/sdk.js — refusing to merge ' +
    'without the protected list (run: node ./node_modules/.bin/tsup)',
  );
}

/**
 * A role name becomes a filename (KB-<name>.md) and a JSON key, so it must be a plain
 * identifier. Anything else is refused rather than sanitised: a silently rewritten name
 * would not match the name the PRD assigns, and the agent would never be found.
 */
const ROLE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isUsableProposal(p) {
  if (!p || typeof p !== 'object') return 'not an object';
  if (typeof p.name !== 'string' || !p.name.trim()) return 'no name';
  if (!ROLE_NAME_RE.test(p.name)) return 'name is not a plain kebab-case identifier';
  if (typeof p.systemPrompt !== 'string' || !p.systemPrompt.trim()) return 'no systemPrompt';
  return null;
}

/**
 * Merge proposals into profiles.json and seed each new role's KB file.
 *
 * @param {object}   opts
 * @param {string}   opts.profilesPath  profiles.json to merge into (read-modify-write)
 * @param {string}  [opts.agentsDir]    where KB-<role>.md lives; defaults to profiles.json's dir
 * @param {object[]} opts.proposals     [{ name, systemPrompt, rationale }]
 * @returns {{minted: object[], rejected: object[], unchanged: string[]}}
 */
function mergeProjectAgents(opts) {
  const { profilesPath, proposals } = opts || {};
  if (!profilesPath) throw new Error('[agent-roster] profilesPath is required');
  const agentsDir = opts.agentsDir || path.dirname(profilesPath);
  const fixed = protectedRoles();

  let profiles = {};
  try {
    profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  } catch (e) {
    // A missing roster is a legitimate first run; an UNPARSEABLE one is not — overwriting
    // it would destroy every existing agent, which is the exact loss this module prevents.
    if (fs.existsSync(profilesPath)) {
      throw new Error(`[agent-roster] ${profilesPath} is not valid JSON — refusing to overwrite it: ${e.message}`);
    }
  }

  const minted = [];
  const rejected = [];
  const unchanged = [];

  for (const p of Array.isArray(proposals) ? proposals : []) {
    const why = isUsableProposal(p);
    if (why) { rejected.push({ name: (p && p.name) || '', reason: why }); continue; }

    if (fixed.has(p.name)) {
      rejected.push({ name: p.name, reason: 'collides with a protected canonical role' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(profiles, p.name)) {
      // Convergence: an existing entry may carry run-accumulated skill notes.
      unchanged.push(p.name);
      continue;
    }

    profiles[p.name] = p.systemPrompt;
    const surfaces = ['profiles.json'];

    // Seed the persistent skills store. The seams append to this file across runs; without
    // it the agent starts every run with no memory of what it learned in the last one.
    const kbPath = path.join(agentsDir, `KB-${p.name}.md`);
    try {
      if (!fs.existsSync(kbPath)) {
        fs.writeFileSync(kbPath,
          `# KB — ${p.name}\n\n` +
          `Persistent, cross-run knowledge for this role. Appended by the pipeline as the\n` +
          `agent learns; injected into its prompts on subsequent runs.\n\n` +
          `Minted for this project because: ${p.rationale || '(no rationale recorded)'}\n`,
          'utf8');
      }
      surfaces.push('kb');
    } catch (e) {
      rejected.push({ name: p.name, reason: `kb seed failed: ${e.message}` });
    }

    minted.push({ name: p.name, rationale: p.rationale || '', surfaces });
  }

  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

  // Register the minted roles. Downstream needs to know which roles are THIS PROJECT'S
  // implementation roles, and "everything in the roster that isn't canonical" cannot
  // answer that: of 38 non-canonical roles in a live roster, only ~9 implement anything —
  // the rest is engine machinery (doc-*, failure-analyst, code-graph-detective, the
  // vocabulary agents). Deriving from that set handed write access to the detective.
  // The mint knows exactly what it created, so it says so explicitly.
  const registered = registerProjectRoles(agentsDir, minted.map((m) => m.name));
  for (const m of minted) if (registered.includes(m.name)) m.surfaces.push('project-roles');

  // Persist the BRIEFS to the project's own store as well.
  //
  // profiles.json is restored from profiles.json.original at the start of every run — the
  // ephemeral-roster design, correct when only skill addendums were project-specific. Now
  // that identities are generated, that restore deleted the minted briefs while the registry
  // and the KB files survived, leaving three halves disagreeing. On a resume (mint skipped)
  // the registry named roles that had no profile, so assignment found zero candidates and
  // refused. Live 2026-08-07.
  //
  // The project's store — not profiles.json.original: writing one project's agents into the
  // engine's canonical base is the contamination this whole change exists to remove.
  const savedProfiles = saveProjectProfiles(agentsDir, minted.reduce((acc, m) => {
    acc[m.name] = profiles[m.name];
    return acc;
  }, {}));
  for (const m of minted) if (savedProfiles.includes(m.name)) m.surfaces.push('project-profiles');

  return { minted, rejected, unchanged, projectRoles: registered };
}

const PROJECT_ROLES_FILE = 'project-roles.json';

/**
 * Where this project's role registry lives.
 *
 * PER PROJECT when EPAM_PROJECT_CONFIG_DIR is set, which is what keeps one project's roles
 * out of another's. The engine-level registry holds epam-cli's own implementation roles (it
 * orchestrates itself); a client codeline must not inherit those. That inheritance is the
 * whole defect: a Metrolinx ticket was assigned typescript-engineer, an agent whose brief
 * describes THIS repo's src/cli internals.
 */
function projectRolesPath(agentsDir) {
  if (process.env.EPAM_PROJECT_ROLES_FILE) return process.env.EPAM_PROJECT_ROLES_FILE;
  if (process.env.EPAM_PROJECT_CONFIG_DIR) {
    return path.join(process.env.EPAM_PROJECT_CONFIG_DIR, PROJECT_ROLES_FILE);
  }
  return path.join(agentsDir, PROJECT_ROLES_FILE);
}

/**
 * The registry of this project's implementation roles. Additive and idempotent: a re-run
 * adds nothing it already contains and never drops a role, because a role dropped here
 * silently loses write access and its stories become unassignable.
 */
function registerProjectRoles(agentsDir, names) {
  const file = projectRolesPath(agentsDir);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* best effort */ }
  let roles = [];
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(existing.roles)) roles = existing.roles.filter((r) => typeof r === 'string');
  } catch { /* first run, or unreadable — rebuilt below */ }

  for (const n of Array.isArray(names) ? names : []) {
    if (typeof n === 'string' && n && !roles.includes(n)) roles.push(n);
  }
  try {
    fs.writeFileSync(file, JSON.stringify({
      _what: 'This project\'s own implementation roles, written by the agent mint. Read by the ' +
             'write perimeter (which roles may author code) and by role assignment (which roles ' +
             'may own a story). Canonical process roles are never listed here.',
      roles,
    }, null, 2), 'utf8');
  } catch { /* registry unwritable — caller still gets the list back */ }
  return roles;
}

const PROJECT_PROFILES_FILE = 'agent-profiles.json';

/** Where this project's minted briefs live — beside its role registry. */
function projectProfilesPath(agentsDir) {
  if (process.env.EPAM_PROJECT_PROFILES_FILE) return process.env.EPAM_PROJECT_PROFILES_FILE;
  if (process.env.EPAM_PROJECT_CONFIG_DIR) {
    return path.join(process.env.EPAM_PROJECT_CONFIG_DIR, PROJECT_PROFILES_FILE);
  }
  return path.join(agentsDir, PROJECT_PROFILES_FILE);
}

/** Additive and idempotent, like the registry: a brief already stored is never rewritten. */
function saveProjectProfiles(agentsDir, briefs) {
  const file = projectProfilesPath(agentsDir);
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')).profiles || {}; } catch { store = {}; }
  for (const [name, brief] of Object.entries(briefs || {})) {
    if (typeof name === 'string' && name && typeof brief === 'string' && brief.trim()
        && !Object.prototype.hasOwnProperty.call(store, name)) {
      store[name] = brief;
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      _what: "This project's minted agent briefs. profiles.json is restored from its canonical " +
             'original at the start of every run, which would otherwise delete them; they are ' +
             're-applied from here. Kept out of the engine base so one project\'s agents never ' +
             "reach another's roster.",
      profiles: store,
    }, null, 2), 'utf8');
  } catch { /* caller still gets the list */ }
  return Object.keys(store);
}

/**
 * Re-apply this project's stored briefs onto the live roster.
 *
 * Called after the per-run restore and before anything reads the roster. ADDITIVE: an entry
 * already present wins, so a canonical role can never be replaced by a stored one and a brief
 * that accumulated skill notes this run is not reverted.
 */
function applyProjectProfiles(profilesPath, agentsDir) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(projectProfilesPath(agentsDir), 'utf8')).profiles || {}; }
  catch { return []; }
  const names = Object.keys(store);
  if (!names.length) return [];

  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); }
  catch { return []; }

  const applied = [];
  for (const n of names) {
    if (!Object.prototype.hasOwnProperty.call(profiles, n)) { profiles[n] = store[n]; applied.push(n); }
  }
  if (applied.length) fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
  return applied;
}

/**
 * Remove this project's minted roster — registry, stored briefs, and the live entries.
 *
 * Only ever called for an EXPLICIT re-mint. Without it, "re-mint" means "add more", which is
 * how two runs left five roles behind including two from a run whose vendor was wrong.
 * Canonical roles are never touched: only names this project registered are removed.
 */
function clearProjectRoster(agentsDir, profilesPath) {
  const registered = projectRoles(agentsDir);
  if (!registered.length) return [];

  try {
    const file = projectRolesPath(agentsDir);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.roles = [];
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  } catch { /* nothing registered to clear */ }

  try {
    const file = projectProfilesPath(agentsDir);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.profiles = {};
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  } catch { /* no store */ }

  try {
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    let changed = false;
    for (const r of registered) {
      if (Object.prototype.hasOwnProperty.call(profiles, r)) { delete profiles[r]; changed = true; }
    }
    if (changed) fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
  } catch { /* live roster unreadable — registry and store are cleared regardless */ }

  return registered;
}

/** Read the registry. Returns [] when absent — callers must fail CLOSED on an empty list. */
function projectRoles(agentsDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectRolesPath(agentsDir), 'utf8'));
    return Array.isArray(parsed.roles) ? parsed.roles.filter((r) => typeof r === 'string') : [];
  } catch { return []; }
}

module.exports = {
  mergeProjectAgents, isUsableProposal, ROLE_NAME_RE,
  registerProjectRoles, projectRoles, projectRolesPath, PROJECT_ROLES_FILE,
  saveProjectProfiles, applyProjectProfiles, projectProfilesPath, PROJECT_PROFILES_FILE,
  clearProjectRoster,
};
