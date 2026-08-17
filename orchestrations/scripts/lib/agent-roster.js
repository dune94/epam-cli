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

/**
 * The two classes of minted agent, and the reason they must never share a registry.
 *
 * An IMPLEMENTER authors code: it is offered to story assignment and the write perimeter
 * grants it write access. An INVESTIGATOR reads code to report what is there: it must never
 * be assignable and must never be able to write. Everything minted used to land in one list —
 * the list the perimeter reads — so minting a detective would have handed an investigator
 * write access to client source. That is the exact incident the perimeter was built for,
 * where ~1050 lines were rewritten during a spec pass by agents that only needed to read.
 */
const AGENT_KINDS = ['implementer', 'investigator'];

// What an implementer writes in `codeline` to mean "the whole project". A sentinel rather than
// an omission: a missing field cannot be told apart from a model that skipped it.
const PROJECT_WIDE = '*';

function proposalKind(p) {
  const k = p && typeof p.kind === 'string' ? p.kind.trim().toLowerCase() : '';
  // Defaults to implementer ONLY when unstated — an unrecognised value is refused rather
  // than coerced, because coercing "detective" to implementer grants write access silently.
  if (!k) return 'implementer';
  return AGENT_KINDS.includes(k) ? k : '';
}

/**
 * Paths a brief names that do NOT exist where that brief will be used.
 *
 * The estate survey scopes its evidence per codeline. The mint then renders every codeline's
 * evidence as one labelled list and writes all the briefs from that pooled view, so nothing
 * stops a path observed in codeline A being written into codeline B's brief. Live 2026-08-09
 * the metrolinx investigator was briefed to start at a context module that exists only in
 * gotransit, plus a directory that exists nowhere.
 *
 * That is the failure that cost 120 iterations on an earlier run: an agent handed a path its
 * checkout does not have assumes a second file exists, creates it, deletes it, declares the
 * real one out of scope, and every retry reproduces the same error.
 *
 * The check is deterministic and total — it reads the filesystem for EVERY path a brief cites,
 * rather than depending on whether a reviewer happens to raise it. The reviewer's findings are
 * already re-checked this way (lib/verify-findings.js); the briefs themselves never were.
 *
 * An investigator is bound to one codeline, so its paths must exist THERE. An implementer
 * spans the estate, so its paths need only exist in some codeline. A codeline that cannot be
 * resolved settles nothing and reports nothing — refusing to guess, as everywhere else here.
 */
/**
 * What a path can START with, read from the repositories rather than assumed.
 *
 * This began as a literal alternation — src|test|tests|lib|app|packages — which is one
 * ecosystem's convention baked into the engine. An estate laid out any other way (cmd/, pkg/,
 * internal/, Sources/) would have had every brief pass unexamined while the check reported
 * itself satisfied, which is worse than not running: a gate that looks at nothing and says
 * "grounded".
 *
 * The roots are the top-level directories the codelines actually have, unioned across the
 * estate — union, because a brief naming a directory that exists in a SIBLING codeline is
 * exactly the defect being hunted, and it has to be recognised as a path before it can be
 * reported as missing.
 */
function codelineRoots(codelines) {
  const roots = new Set();
  for (const c of codelines) {
    let entries = [];
    try { entries = fs.readdirSync(c.path, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;          // .git, .epam — never cited as work
      roots.add(e.name);
    }
  }
  return roots;
}

/**
 * Does this cited path name something real in this codeline?
 *
 * Literal resolution alone rejects the codebase's own convention. Live 2026-08-09 the mint
 * refused all three investigators in one cycle, one of them for `src/hooks/useContent` — a file
 * that exists as useContent.ts in every codeline. The survey had reported it without its
 * extension, so the brief inherited that form, and `import { x } from 'hooks/useContent'` is how
 * TypeScript and every bundler spell it. The correction loop re-minted and recovered, at the
 * cost of a cycle per lane, and a brief that did not get corrected would have been refused
 * outright.
 *
 * So: the literal path, or the same path carrying any extension the directory actually holds.
 * The location is still exact — an extension-less path in the WRONG directory resolves to
 * nothing, and a path naming an extension the tree does not have is still reported.
 */
function resolvesIn(repoPath, cited) {
  const root = path.resolve(repoPath);
  const target = path.resolve(repoPath, cited);
  // Never resolve outside the repository, whatever the citation says.
  if (target !== root && !target.startsWith(root + path.sep)) return false;
  if (fs.existsSync(target)) return true;

  // An extension-less module reference: accept it if the directory holds a file whose name
  // is this one plus an extension. Derived from the tree, so no extension list appears here.
  if (path.extname(cited)) return false;
  const dir = path.dirname(target);
  const base = path.basename(target);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return false; }
  return entries.some((e) => e.startsWith(base + '.') && !e.slice(base.length + 1).includes('.')
    ? true
    : e.startsWith(base + '.'));
}

function ungroundedBriefPaths(proposal, codelines) {
  const brief = proposal && typeof proposal.systemPrompt === 'string' ? proposal.systemPrompt : '';
  const list = Array.isArray(codelines) ? codelines.filter((c) => c && c.name && c.path) : [];
  if (!brief || !list.length) return [];

  const declared = String((proposal && proposal.codeline) || '').trim();
  const spans = !declared || declared === PROJECT_WIDE;
  const scope = spans ? list : list.filter((c) => c.name === declared);
  // Named a codeline this estate does not have: nothing to check it against, and inventing a
  // verdict from the other repositories would be worse than silence.
  if (!scope.length) return [];

  // Roots come from the whole estate, so a sibling's directory is still recognised as a path
  // and can then be reported as absent from THIS codeline.
  const roots = codelineRoots(list);

  // Every slash-bearing token in the brief, then kept on STRUCTURE rather than vocabulary:
  //   - its last segment carries an extension  (…/client.go, …/contentstack.ts), or
  //   - it is written as a directory           (src/providers/), or
  //   - it starts at a directory the estate actually has (roots, above).
  // The first two catch a root this estate does not have at all — an invented `vendor/…` is
  // exactly the kind of path a brief should not carry. The third catches a directory cited
  // without a trailing slash. Prose like "read/write" or "and/or" satisfies none of them.
  const CANDIDATE_RE = /\b[A-Za-z0-9_.\-[\]]+(?:\/[A-Za-z0-9_.\-[\]]*)+\/?/g;
  const looksLikePath = (tok) => {
    const segs = tok.replace(/\/+$/, '').split('/');
    if (segs.length < 2) return false;
    if (tok.endsWith('/')) return true;
    if (/\.[A-Za-z0-9]+$/.test(segs[segs.length - 1])) return true;
    return roots.has(segs[0]);
  };

  const cited = [...new Set(brief.match(CANDIDATE_RE) || [])]
    .filter(looksLikePath)
    // Trailing punctuation from prose ("at src/x.ts.") is not part of the path.
    .map((p) => p.replace(/[.,;:)\]]+$/, ''))
    .filter(Boolean)
    // A brief must not send anything outside the repository, and a traversal cannot be
    // resolved safely — drop rather than stat it.
    .filter((p) => !p.split('/').includes('..'));

  const missing = [];
  for (const p of cited) {
    const foundSomewhere = scope.some((c) => resolvesIn(c.path, p));
    if (!foundSomewhere) missing.push(p);
  }
  return missing;
}

function isUsableProposal(p) {
  if (!p || typeof p !== 'object') return 'not an object';
  if (typeof p.name !== 'string' || !p.name.trim()) return 'no name';
  if (!ROLE_NAME_RE.test(p.name)) return 'name is not a plain kebab-case identifier';
  if (typeof p.systemPrompt !== 'string' || !p.systemPrompt.trim()) return 'no systemPrompt';
  if (!proposalKind(p)) return `unrecognised kind "${p.kind}" (expected one of: ${AGENT_KINDS.join(', ')})`;
  // AN INVESTIGATOR WITHOUT A CODELINE CANNOT BE BOUND TO ANYTHING.
  //
  // The lane resolves its investigator BY CODELINE. One minted without that field is registered,
  // briefed, given a KB — and unreachable: every lane falls through to the canonical detective
  // and the per-codeline briefs are inert. Live 2026-08-07: one run supplied the field and the
  // next did not, so the whole mechanism silently stopped working between two runs of identical
  // code. The schema marks it optional because JSON Schema cannot make it conditional on kind;
  // that makes it this function's job, not the model's.
  const _cl = typeof p.codeline === 'string' ? p.codeline.trim() : '';
  if (!_cl) {
    // Required of BOTH kinds now. The schema enforces the field's presence; this enforces that
    // it says something. An implementer spans the project and states so explicitly, rather than
    // by omission — silence is indistinguishable from a model that simply skipped the field,
    // which is precisely what happened on 2026-08-07 and left a run with no roster at all.
    return 'every proposal must state a codeline — the one it investigates, or "*" for a role that spans the project';
  }
  if (proposalKind(p) === 'investigator' && _cl === PROJECT_WIDE) {
    return 'an investigator must name ONE codeline, not the whole project — the lane looks it up by codeline';
  }

  // A REQUIRED FIELD THAT ACCEPTS ANYTHING IS NOT REQUIRED.
  //
  // The schema marks `rationale` required, so a model cannot omit it — and on 2026-08-07 all
  // five minted agents returned the rationale "...". The schema was satisfied and nothing was
  // said. That field is the justification the operator reads at the roster pause (which exists
  // so a human can assess the team before it is given work), the seed line of each agent's KB,
  // and what a corrective cycle is told about the roles it is keeping.
  //
  // Structural check only: count letters and digits after collapsing whitespace. No vocabulary
  // list, no required phrasing — this constrains that the field argues SOMETHING, never what it
  // argues. Padding with punctuation buys nothing because punctuation is not counted.
  const _rationale = typeof p.rationale === 'string' ? p.rationale : '';
  const _weight = (_rationale.match(/[\p{L}\p{N}]/gu) || []).length;
  const _min = Number(process.env.EPAM_ROSTER_RATIONALE_MIN_CHARS || '24');
  if (_weight < _min) {
    return `rationale says nothing (${_weight} letters/digits, minimum ${_min}) — it is what the ` +
           'operator reviews at the roster pause and what seeds the agent KB; state why THIS ' +
           'project needs THIS role';
  }
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
  const { profilesPath, proposals, codelines } = opts || {};
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

    // A brief is inherited whole and re-checked by nothing, so a path it names becomes an
    // instruction. Refused here rather than surfaced later: the correction cycle re-mints on
    // a rejection, and the reason names the exact paths so the replacement can be grounded.
    const _ungrounded = ungroundedBriefPaths(p, codelines);
    if (_ungrounded.length) {
      rejected.push({
        name: p.name,
        reason:
          `brief names ${_ungrounded.length} path(s) that do not exist in ` +
          `${(p.codeline && p.codeline !== PROJECT_WIDE) ? `codeline '${p.codeline}'` : 'any codeline'}: ` +
          `${_ungrounded.join(', ')}`,
      });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(profiles, p.name)) {
      // Convergence: an existing entry may carry run-accumulated skill notes.
      unchanged.push(p.name);
      continue;
    }

    profiles[p.name] = p.systemPrompt;
    const surfaces = ['profiles.json'];

    // NO per-role KB file. The stores are per CODELINE and are seeded after the merge — a
    // role-keyed file is written at an address nothing reads, and because role names are
    // minted fresh each run it would accumulate forever (36 such files were on disk).
    surfaces.push('kb');

    minted.push({
      name: p.name, kind: proposalKind(p),
      codeline: (() => {
        const c = typeof p.codeline === 'string' ? p.codeline.trim() : '';
        return c === PROJECT_WIDE ? '' : c;   // project-wide is not a codeline anything binds to
      })(),
      rationale: p.rationale || '', surfaces,
    });
  }

  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');

  // Register the minted roles. Downstream needs to know which roles are THIS PROJECT'S
  // implementation roles, and "everything in the roster that isn't canonical" cannot
  // answer that: of 38 non-canonical roles in a live roster, only ~9 implement anything —
  // the rest is engine machinery (doc-*, failure-analyst, code-graph-detective, the
  // vocabulary agents). Deriving from that set handed write access to the detective.
  // The mint knows exactly what it created, so it says so explicitly.
  // ROUTED BY KIND. Only implementers reach the registry the write perimeter reads.
  // SEED THE STORES THE PIPELINE ACTUALLY READS: one per codeline, plus the shared store for
  // work that spans the project. Existing files are never overwritten — whatever earlier runs
  // learned is the point of having them.
  for (const _cl of [...(Array.isArray(codelines) ? codelines : []).map((c) => (typeof c === 'string' ? c : c && c.name)), '']) {
    const _kb = kbFileForCodeline(agentsDir, _cl);
    if (fs.existsSync(_kb)) continue;
    try {
      fs.writeFileSync(_kb,
        `# KB — ${_cl || 'shared'}\n\n` +
        'Persistent, cross-run knowledge for this codeline. Appended by the pipeline as agents\n' +
        'learn, and injected into their prompts on later runs. Never reset between runs: this is\n' +
        'the one store that is meant to survive.\n', 'utf8');
    } catch { /* a store that cannot be seeded is not fatal — the appenders create on write */ }
  }

  const registered = registerProjectRoles(
    agentsDir, minted.filter((m) => m.kind === 'implementer').map((m) => m.name));
  const registeredInv = registerProjectInvestigators(
    agentsDir, minted.filter((m) => m.kind === 'investigator').map((m) => ({ name: m.name, codeline: m.codeline })));
  for (const m of minted) {
    if (m.kind === 'implementer' && registered.includes(m.name)) m.surfaces.push('project-roles');
    if (m.kind === 'investigator' && registeredInv.includes(m.name)) m.surfaces.push('project-investigators');
  }

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

  return { minted, rejected, unchanged, projectRoles: registered, projectInvestigators: registeredInv };
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
/**
 * kbFileForCodeline(agentsDir, codeline) — THE address of a codeline's knowledge store.
 *
 * One function, because there were two. The mint seeded `KB-<role>.md` while claude.sh read
 * and appended `KB-<codeline>.md`, so the file written was never the file read. On disk
 * 2026-08-08: 36 KB files, all role-keyed, none readable — and because role names are minted
 * fresh every run they accumulated forever (a file from the run that hallucinated a vendor was
 * still there). The cost estimator reported it plainly: "KB coverage: 0%".
 *
 * Cross-run learning is the only reason the KB exists, and it had never once happened.
 *
 * Normalised — lowercased, punctuation collapsed — so casing or dots in a codeline label
 * cannot fork one store into several. That does NOT fix ID-1 (the same repository has been
 * labelled "gotransit" and "nextgotransitcom" on different runs); it only guarantees this
 * layer adds no forks of its own. claude.sh's _kb_file_for_story normalises identically, and a
 * test executes both and compares them character for character.
 */
function kbFileForCodeline(agentsDir, codeline) {
  const slug = String(codeline || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(agentsDir, `KB-${slug || 'shared'}.md`);
}

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

const PROJECT_INVESTIGATORS_FILE = 'project-investigators.json';

/** Where this project's read-only investigators are registered — never the write registry. */
function projectInvestigatorsPath(agentsDir) {
  if (process.env.EPAM_PROJECT_INVESTIGATORS_FILE) return process.env.EPAM_PROJECT_INVESTIGATORS_FILE;
  if (process.env.EPAM_PROJECT_CONFIG_DIR) {
    return path.join(process.env.EPAM_PROJECT_CONFIG_DIR, PROJECT_INVESTIGATORS_FILE);
  }
  return path.join(agentsDir, PROJECT_INVESTIGATORS_FILE);
}

function registerProjectInvestigators(agentsDir, names) {
  const file = projectInvestigatorsPath(agentsDir);
  let roles = [];
  let byCodeline = {};
  try {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(existing.investigators)) roles = existing.investigators.filter((r) => typeof r === 'string');
    if (existing.byCodeline && typeof existing.byCodeline === 'object') byCodeline = existing.byCodeline;
  } catch { /* first run */ }
  for (const n of Array.isArray(names) ? names : []) {
    const nm = typeof n === 'string' ? n : (n && n.name);
    const cl = (n && typeof n === 'object' && typeof n.codeline === 'string') ? n.codeline : '';
    if (typeof nm === 'string' && nm && !roles.includes(nm)) roles.push(nm);
    // The lane looks its detective up BY CODELINE, so the mapping is what makes the mint
    // usable at all; a list of names alone leaves each lane guessing which one is its own.
    if (nm && cl) byCodeline[cl] = nm;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      _what: "This project's minted READ-ONLY agents — investigators. They report what is in the " +
             'code and never author it. The write perimeter does not read this file, and story ' +
             'assignment never offers these names.',
      investigators: roles,
      byCodeline,
    }, null, 2), 'utf8');
  } catch { /* caller still gets the list */ }
  return roles;
}

/** The investigator briefed for one codeline, or '' when none was minted for it. */
function investigatorForCodeline(agentsDir, codeline) {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectInvestigatorsPath(agentsDir), 'utf8'));
    const m = parsed.byCodeline || {};
    return (codeline && typeof m[codeline] === 'string') ? m[codeline] : '';
  } catch { return ''; }
}

function projectInvestigators(agentsDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectInvestigatorsPath(agentsDir), 'utf8'));
    return Array.isArray(parsed.investigators) ? parsed.investigators.filter((r) => typeof r === 'string') : [];
  } catch { return []; }
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
      runId: process.env.ORCH_RUN_ID || '',
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
 * Which run minted the stored roster, if any.
 *
 * The roster is REGENERATED every run, from the canonical base — a run must never start from
 * a roster another run mutated. But it must stay fixed WITHIN a run, or a resume after the
 * roster pause would re-propose and the operator would return to different agents than the
 * ones they reviewed. Stamping the store with the run that made it distinguishes the two
 * without a separate reset step that could be forgotten.
 */
function rosterRunId(agentsDir) {
  try { return JSON.parse(fs.readFileSync(projectProfilesPath(agentsDir), 'utf8')).runId || ''; }
  catch { return ''; }
}

/**
 * Remove this project's minted roster — registry, stored briefs, and the live entries.
 *
 * Only ever called for an EXPLICIT re-mint. Without it, "re-mint" means "add more", which is
 * how two runs left five roles behind including two from a run whose vendor was wrong.
 * Canonical roles are never touched: only names this project registered are removed.
 */
/**
 * clearProjectRoster(agentsDir, profilesPath[, names])
 *
 * With no `names`, removes every minted agent — the ephemeral-roster rule: a run starts from
 * the canonical base, never from a previous run's mutated roster.
 *
 * With `names`, removes ONLY those agents. This is what a corrective review cycle uses. It
 * used to clear wholesale on any blocking finding, so one defective brief discarded every
 * sound one alongside it and re-derived them all — and since minting is a sampling process, a
 * correct brief was as likely to come back subtly wrong as to come back the same. A cycle
 * meant to converge could move the roster sideways, on the reviewer's own limited budget.
 *
 * An EMPTY array means "no agent was named" (findings about a GAP in the roster rather than a
 * defect in a brief) and clears nothing. Only the absent argument means all.
 */
function clearProjectRoster(agentsDir, profilesPath, names) {
  const targeted = Array.isArray(names);
  const all = [...projectRoles(agentsDir), ...projectInvestigators(agentsDir)];
  const registered = targeted ? all.filter((r) => names.includes(r)) : all;
  if (!registered.length) return [];
  const drop = (list) => (Array.isArray(list) ? list.filter((r) => !registered.includes(r)) : []);

  // Both registries. An investigator left behind would be re-applied next run as a role the
  // roster never proposed — the same aggregation the ephemeral-roster rule forbids.
  try {
    const file = projectInvestigatorsPath(agentsDir);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.investigators = drop(parsed.investigators);
    // The codeline mapping too. Left behind, it points a lane at a detective whose brief no
    // longer exists — resolving to a name with no profile, which reads as "minted" and
    // investigates with nothing. A targeted clear drops only the mappings whose investigator
    // is going; the lanes whose detective survived keep theirs.
    parsed.byCodeline = Object.fromEntries(
      Object.entries(parsed.byCodeline || {}).filter(([, nm]) => !registered.includes(nm)));
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  } catch { /* none registered */ }

  try {
    const file = projectRolesPath(agentsDir);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.roles = drop(parsed.roles);
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  } catch { /* nothing registered to clear */ }

  try {
    const file = projectProfilesPath(agentsDir);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.profiles = Object.fromEntries(
      Object.entries(parsed.profiles || {}).filter(([nm]) => !registered.includes(nm)));
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

/**
 * partitionRosterFindings(blockingFindings, mintedAgents)
 *
 * Decides what a corrective cycle replaces and what it keeps.
 *
 * A finding names the agent whose brief is defective in `agent`. That agent is INDICTED and
 * will be re-proposed. Everything else the mint produced is RETAINED — it passed the same
 * adversarial review, and re-deriving it is a fresh sample that can come back worse.
 *
 * A finding naming no agent, or naming one not in this roster, indicts nothing: it is a
 * statement about a GAP in coverage ("no role reads codeline X"). Those are counted, not
 * matched to a victim — they tell the correction to ADD, and they must never be allowed to
 * collapse into "clear everything", which is how the wholesale behaviour crept in.
 *
 * Returns { indicted: string[], retained: object[], gaps: number }.
 */
function partitionRosterFindings(blockingFindings, mintedAgents) {
  const minted = Array.isArray(mintedAgents) ? mintedAgents.filter((m) => m && m.name) : [];
  const names = new Set(minted.map((m) => m.name));
  const findings = Array.isArray(blockingFindings) ? blockingFindings.filter(Boolean) : [];

  const indicted = [...new Set(
    findings.map((f) => f.agent).filter((n) => typeof n === 'string' && names.has(n)))];
  const gaps = findings.filter((f) => !(typeof f.agent === 'string' && names.has(f.agent))).length;

  return { indicted, retained: minted.filter((m) => !indicted.includes(m.name)), gaps };
}

/**
 * hasProjectRoster(agentsDir) — is there anything minted from a previous run to clear?
 *
 * ONE answer, fed by BOTH registries. The mint used to decide this from the roles list alone:
 * live 2026-08-08, a failed mint had left roles empty while three investigators from the run
 * before survived, so the ephemeral-roster clear was skipped entirely and the next run
 * appended to them — the cross-run aggregation the rule forbids. A registered investigator
 * with no profile is worse than an absent one: it resolves to a name that reads as minted and
 * investigates with nothing.
 */
function hasProjectRoster(agentsDir) {
  return projectRoles(agentsDir).length > 0 || projectInvestigators(agentsDir).length > 0;
}

/**
 * rosterReviewIsRequired({verdict, mintSkipped, pauseConfigured})
 *
 * Should the step REFUSE to continue because the roster is unreviewed?
 *
 * The reviewer is the only thing between a generated brief and an implementer inheriting it,
 * so silence must never read as approval. But on a RESUME the mint is skipped deliberately and
 * the review already happened — in the run being resumed, before the operator approved it at
 * the pause. Live 2026-08-08: this guard refused a roster that had been reviewed and approved,
 * and killed the resume.
 *
 * A configured pause defers to the operator rather than refusing: they are about to look at it.
 */
function rosterReviewIsRequired({ verdict, mintSkipped, pauseConfigured } = {}) {
  if (mintSkipped) return false;          // resumed: reviewed in the run being resumed
  if (pauseConfigured) return false;      // a human is about to see it
  // 'nothing_to_review' joins them: an empty roster owes a review the moment it gains an agent.
  // Treating it as settled is how a vacuous pass returns by the back door.
  return verdict === 'not_run' || verdict === 'review_failed' || verdict === 'nothing_to_review';
}

/**
 * WHAT KIND AN AGENT IS, from where the pipeline already records it.
 *
 * The roster stores each agent's brief as a STRING, so there is no `kind` field to read on a
 * profile — the kind is expressed by MEMBERSHIP: project-roles.json lists the roles stories are
 * assigned to, project-investigators.json lists the per-codeline readers. Both registries and
 * their meaning are owned here, which is why the lookup belongs here and not in the caller.
 *
 * Added 2026-08-17 after a seam fix was written against a fixture shaped {kind, brief} and was
 * therefore inert on the real data: 'typescript-vitest-implementer' still resolved to no seam
 * because entry.kind on a string is undefined, and a unit test with the wrong fixture said it
 * worked. Returns '' when the agent is in neither registry — an unknown kind must stay
 * distinguishable from a declared one.
 */
function kindOfAgent(agent, agentsDir) {
  if (!agent) return '';
  const inList = (names) => Array.isArray(names) && names.includes(agent);
  try { if (inList(projectRoles(agentsDir))) return AGENT_KINDS[0]; } catch { /* not registered */ }
  try { if (inList(projectInvestigators(agentsDir))) return AGENT_KINDS[1]; } catch { /* not registered */ }
  return '';
}

module.exports = {
  kindOfAgent,
  partitionRosterFindings,
  kbFileForCodeline,
  rosterReviewIsRequired,
  hasProjectRoster,
  mergeProjectAgents, isUsableProposal, ROLE_NAME_RE, ungroundedBriefPaths,
  registerProjectRoles, projectRoles, projectRolesPath, PROJECT_ROLES_FILE,
  saveProjectProfiles, applyProjectProfiles, projectProfilesPath, PROJECT_PROFILES_FILE,
  clearProjectRoster, rosterRunId, PROJECT_WIDE,
  registerProjectInvestigators, projectInvestigators, projectInvestigatorsPath, investigatorForCodeline,
  proposalKind, AGENT_KINDS, PROJECT_INVESTIGATORS_FILE,
};
