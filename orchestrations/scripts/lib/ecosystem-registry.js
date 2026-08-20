/**
 * ECOSYSTEM REGISTRY — resolves providers at RUN TIME. The engine names no stack.
 *
 * REPLACES lib/ecosystem-registry.js, which was a table of "the ecosystems this engine knows". Six stacks
 * were enumerated in engine source, so onboarding a seventh meant editing the pipeline — and every
 * guard that consulted the table was generic only across the stacks already listed. That is the
 * shape of a fact the pipeline must not hold.
 *
 * A provider is a module describing ONE ecosystem: the manifest file that identifies it, what it
 * vendors, what it leaves behind, what a writer must not touch, and how to read its manifest.
 * Those last parts are real parsers — JSON for a package manifest, section matching for TOML, line
 * rules for a requirements file — so a provider is code, not a config row. It is loaded from a
 * DIRECTORY, discovered by listing, never by a name written here.
 *
 * Adding an ecosystem is a new file in a provider directory. There is no engine change, no case
 * statement, and no list to append to.
 *
 * Provider directories, in order:
 *   1. orchestrations/ecosystems              — the ones that ship
 *   2. $EPAM_ECOSYSTEM_PROVIDERS              — colon-separated, injected per run
 *
 * A later directory may REPLACE an earlier provider by declaring the same `file`, so a codeline
 * that reads its manifest differently supplies its own provider without forking the engine.
 *
 * EPAM_CODELINE_MANIFESTS still extends the set for an ecosystem with no provider at all
 * ("manifest:installDir,manifest:") — the minimum a scan needs to stop calling a repository
 * `unknown`.
 *
 * NO FALLBACK TABLE. If no provider directory resolves, this returns an empty set and the callers
 * that need an ecosystem must say they could not determine one. A built-in default would be a
 * second definition of the same fact, and the second definition is the one that drifts.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** Where providers ship. Resolved from THIS file, so it holds no absolute path. */
const BUILTIN_DIR = path.resolve(__dirname, '../../ecosystems');

/** Provider directories, earliest first. Later entries win on a duplicate `file`. */
function providerDirs(env = process.env) {
  const extra = String((env && env.EPAM_ECOSYSTEM_PROVIDERS) || '')
    .split(':').map((s) => s.trim()).filter(Boolean);
  return [BUILTIN_DIR, ...extra];
}

/**
 * Every provider, discovered by listing the directories.
 *
 * A provider that throws on load is SKIPPED LOUDLY on stderr rather than silently dropped: an
 * ecosystem that vanishes because its file has a syntax error would otherwise present as "this
 * repository is not that stack", which is a wrong answer wearing the shape of a right one.
 */
function loadProviders(env = process.env) {
  const byFile = new Map();
  for (const dir of providerDirs(env)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.js')).sort()) {
      const p = path.join(dir, n);
      let mod;
      try { mod = require(p); } catch (e) {
        process.stderr.write(`[ecosystem-registry] provider ${p} did not load: ${e.message}\n`);
        continue;
      }
      if (!mod || typeof mod.file !== 'string' || !mod.file) {
        process.stderr.write(`[ecosystem-registry] provider ${p} declares no manifest file — ignored\n`);
        continue;
      }
      byFile.set(mod.file, mod);
    }
  }
  // ORDERED BY DECLARED PRECEDENCE. Consumers resolve a repository's ecosystem with a
  // first-match-wins `find`, so load order is behaviour: a Node repository that also carries a
  // Gemfile must not resolve as ruby because of how a directory listing sorted. A provider that
  // declares none sorts last, never silently ahead of one that did.
  return [...byFile.values()].sort(
    (a, b) => (a.precedence ?? Number.MAX_SAFE_INTEGER) - (b.precedence ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Extra ecosystems without a provider: "manifest:installDir,manifest:" */
function extraManifests(env) {
  const raw = (env && env.EPAM_CODELINE_MANIFESTS) || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [file, installDir] = pair.split(':');
    // No `stack` is declared for a runtime addition, so the scan reports the manifest filename
    // itself. Saying which file was found beats saying `unknown`.
    return { file, stack: file, installDir: installDir || null, artifactDirs: installDir ? [installDir] : [], deps: () => [] };
  });
}

function allManifests(env = process.env) {
  const providers = loadProviders(env);
  const extra = extraManifests(env).filter((e) => !providers.some((p) => p.file === e.file));
  return [...providers, ...extra];
}

/**
 * EVERY DIRECTORY ANY RESOLVED ECOSYSTEM LEAVES BEHIND, deduped.
 *
 * The union, not the detected ecosystem's — a monorepo mixes stacks, and excluding a directory a
 * repository does not have costs nothing.
 */
function allArtifactDirs(env = process.env) {
  const seen = new Set();
  for (const eco of allManifests(env)) for (const d of eco.artifactDirs || []) seen.add(d);
  return [...seen];
}

/**
 * WHICH LOCKFILE THIS REPOSITORY CARRIES, first match wins — the same order that decides the
 * package manager, so the two can never disagree. Takes an `exists` predicate rather than
 * touching the filesystem.
 */
const lockfileFor = (eco, exists) => Object.keys((eco && eco.lockfiles) || {}).find((f) => exists(f)) || '';

module.exports = {
  lockfileFor,
  allManifests,
  extraManifests,
  allArtifactDirs,
  loadProviders,
  providerDirs,
  BUILTIN_DIR,
  // Compatibility for importers that read a static list. Resolved on ACCESS, so it reflects the
  // providers present at the moment it is read rather than a snapshot taken at require() time.
  get MANIFESTS() { return allManifests(); },
};
