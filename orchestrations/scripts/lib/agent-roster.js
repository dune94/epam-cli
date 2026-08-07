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
  return { minted, rejected, unchanged };
}

module.exports = { mergeProjectAgents, isUsableProposal, ROLE_NAME_RE };
