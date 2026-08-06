// codeline-structure.js — structural facts about a repository.
//
// WHY THIS EXISTS
// ---------------
// scoreRepos() ranked repositories by lexical text-match frequency: "how often
// do the ticket's words appear in this repo's text". The question discovery has
// to answer is "which repo IMPLEMENTS the capability this ticket concerns".
// Term frequency cannot separate those two, and the gap is not theoretical:
// live, a .NET CRM integration scored 143 against the real target's 152 on 25
// hits that were all accessibility-request validators. It had no live-preview
// code and no installed toolchain, so it could not have run its own gates. The
// model included it on the fifth of five runs.
//
// Everything layered on top of the lexical score — a hand-maintained domain
// stopword list, a recency multiplier, cross-repo IDF, near-tie confidence
// logging — corrects a signal that measures the wrong thing.
//
// The facts below are not opinions and cannot be gamed by word count:
//
//   declaredDependencies  the repo's own manifest says it uses this technology
//   canRunItsOwnGates     the repo's declared toolchain is actually installed
//
// A repo that cannot build is not a candidate at ANY relevance score — selecting
// it guarantees a failed lane. That is a hard filter, not a demotion.
//
// STACK-AGNOSTIC BY CONSTRUCTION. No ecosystem is privileged: MANIFESTS is a
// table of (manifest file -> how to read its dependency names -> where that
// ecosystem installs them). Adding a language is a table entry, not a code
// change, and EPAM_CODELINE_MANIFESTS can extend it without touching this file.
// Nothing here names a client, product, or industry noun.

const fs   = require('fs');
const path = require('path');

/**
 * (manifest file, dependency extractor, install directory) per ecosystem.
 * `installDir: null` means the ecosystem vendors nothing locally, so a missing
 * directory is not evidence of an unbuildable repo.
 */
const MANIFESTS = [
  {
    file: 'package.json',
    installDir: 'node_modules',
    deps: (text) => {
      const pkg = JSON.parse(text);
      return Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    },
  },
  {
    file: 'pyproject.toml',
    installDir: null, // a virtualenv commonly lives outside the repo
    deps: (text) => {
      const out = [];
      // [project] dependencies = ["a", "b>=1"]  and poetry's [tool.poetry.dependencies]
      //
      // Match a COMPLETE quoted string, then strip the version specifier. An
      // earlier version matched from an opening quote to the next delimiter,
      // which also matched the `", ` BETWEEN two entries and yielded a
      // dependency literally named ",". That junk name normalised to the empty
      // string, and "anything".includes("") is true in JS — so one malformed
      // entry matched every ticket term and handed a repo a perfect structural
      // score. Caught by codeline-discovery.test.ts's live AMSD-1820 ranking.
      const arr = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (arr) {
        for (const m of arr[1].matchAll(/["']([^"']+)["']/g)) {
          const name = m[1].split(/[<>=!~^;[\s]/)[0].trim();
          if (name) out.push(name);
        }
      }
      const poetry = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/);
      if (poetry) for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)) out.push(m[1]);
      return out;
    },
  },
  {
    file: 'requirements.txt',
    installDir: null,
    deps: (text) => text.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
      .map((l) => l.split(/[<>=!~[;]/)[0].trim())
      .filter(Boolean),
  },
  {
    file: 'go.mod',
    installDir: null, // module cache is global, not in-repo
    deps: (text) => [...text.matchAll(/^\s+([\w.\-/]+)\s+v[\d.]/gm)].map((m) => m[1]),
  },
  {
    file: 'Cargo.toml',
    installDir: null,
    deps: (text) => {
      const sec = text.match(/\[dependencies\]([\s\S]*?)(\n\[|$)/);
      return sec ? [...sec[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]) : [];
    },
  },
  {
    file: 'Gemfile',
    installDir: null,
    deps: (text) => [...text.matchAll(/^\s*gem\s+['"]([^'"]+)/gm)].map((m) => m[1]),
  },
];

/** Extra ecosystems without editing this file: "manifest:installDir,manifest:" */
function extraManifests(env) {
  const raw = (env && env.EPAM_CODELINE_MANIFESTS) || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [file, installDir] = pair.split(':');
    return { file, installDir: installDir || null, deps: () => [] };
  });
}

function allManifests(env = process.env) {
  return [...MANIFESTS, ...extraManifests(env)];
}

/**
 * declaredDependencies(repoPath) -> Set<string>
 * What the repository ITSELF says it depends on. A name only appears here if a
 * manifest declares it — no amount of mentioning a library in comments or
 * validator text puts it in this set.
 */
function declaredDependencies(repoPath, env = process.env) {
  const found = new Set();
  for (const m of allManifests(env)) {
    const p = path.join(repoPath, m.file);
    if (!fs.existsSync(p)) continue;
    try {
      for (const d of m.deps(fs.readFileSync(p, 'utf8')) || []) if (d) found.add(d);
    } catch { /* an unparseable manifest declares nothing, it does not throw */ }
  }
  return found;
}

/**
 * canRunItsOwnGates(repoPath) -> boolean
 * Can this repo build and run its own tests as a lane?
 *
 * A repo that declares dependencies for an ecosystem that vendors them locally
 * must actually have them installed. Declaring none is fine — nothing to
 * install is not unhealthy (matching lib/codeline-health.sh's own rule, which
 * passes a codeline that declares nothing).
 */
function canRunItsOwnGates(repoPath, env = process.env) {
  for (const m of allManifests(env)) {
    const manifest = path.join(repoPath, m.file);
    if (!fs.existsSync(manifest)) continue;
    if (!m.installDir) continue;                 // nothing is vendored in-repo
    let declared = [];
    try { declared = m.deps(fs.readFileSync(manifest, 'utf8')) || []; } catch { declared = []; }
    if (!declared.length) continue;              // declares nothing to install
    const installed = path.join(repoPath, m.installDir);
    if (!fs.existsSync(installed)) return false; // declared deps, never installed
  }
  return true;
}

/** Raw count of a term across the repo's tracked-ish source — the OLD signal, kept only to compare against. */
function lexicalMentionCount(repoPath, term) {
  let count = 0;
  const stack = [repoPath];
  const SKIP = new Set(['.git', 'node_modules']);
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      try {
        const t = fs.readFileSync(p, 'utf8');
        count += (t.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      } catch { /* binary or unreadable */ }
    }
  }
  return count;
}

/**
 * rankByStructure(repos, terms) -> repos, unbuildable REMOVED, ordered by
 * structural evidence (declared-dependency matches) descending.
 *
 * Deliberately NOT a picker. It removes repos that cannot run as a lane and
 * orders the rest by hard evidence; a multi-codeline ticket must keep every
 * genuine candidate. Lexical relevance stays where it was — in scoreRepos —
 * and now only breaks ties between structurally-equal repos.
 */
function rankByStructure(repos, terms, env = process.env) {
  const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  // MIN_TOKEN guards substring matching. Without a floor, a short or malformed
  // name matches far too much: the empty string matches EVERYTHING (JS
  // `"x".includes("") === true`), and a two-letter name like "ui" matches any
  // term containing it. Substring matching only earns its keep for names long
  // enough to be distinctive; anything shorter must match exactly.
  const MIN_TOKEN = Number(env.CODELINE_STRUCTURAL_MIN_TOKEN || 4);

  const wanted = (terms || []).map(normalise).filter((t) => t.length >= MIN_TOKEN);

  const matches = (term, dep) => {
    if (!term || !dep) return false;          // never let an empty name match
    if (term === dep) return true;            // exact always counts
    if (dep.length < MIN_TOKEN) return false; // too short to substring safely
    // Either may contain the other: "livepreviewutils" should match a scoped
    // "scopelivepreviewutils".
    return dep.includes(term) || term.includes(dep);
  };

  return (repos || [])
    .filter((r) => canRunItsOwnGates(r.path, env))
    .map((r) => {
      const deps = [...declaredDependencies(r.path, env)].map(normalise).filter(Boolean);
      const hits = wanted.filter((w) => deps.some((d) => matches(w, d)));
      return { ...r, structuralScore: hits.length, dependencyHits: hits };
    })
    .sort((a, b) => b.structuralScore - a.structuralScore);
}

module.exports = {
  declaredDependencies,
  canRunItsOwnGates,
  lexicalMentionCount,
  rankByStructure,
  MANIFESTS,
};
