/**
 * codeline-name.js — a short identifier for a repository directory.
 *
 * Extracted so it can be tested directly: codeline-discovery.js is a CLI that
 * runs an IIFE on load, so requiring it to reach one pure function executes a
 * discovery pass.
 *
 * This is the DETERMINISTIC path, used whenever the discovery LLM returns
 * nothing usable — which is often enough to matter. It must agree with rule 4 of
 * the prompt, because which one you get depends only on whether a model call
 * happened to succeed, and a codeline's name is what every downstream worktree
 * lookup is keyed on.
 *
 * Live mock1 run 7: the previous implementation popped the LAST meaningful
 * segment, so "mock-hello-world" became "world". The phase then ran as codeline
 * 'world' while the worktree lookups expected the full name, and failed. The
 * prompt meanwhile told the agent to keep every remaining word. Two parts of the
 * pipeline agreeing in intent and disagreeing in detail, with nothing binding
 * them — the defect shape this codebase produces most.
 */

// Decoration, not identity: platform and hosting prefixes that appear across
// many repositories in an estate and so distinguish none of them. Removed only
// when something else remains — "api" alone is a perfectly good name for a repo
// called "api".
const DECORATION = new Set([
  'azure', 'aws', 'gcp', 'next', 'react', 'vue', 'angular',
  'app', 'web', 'www', 'site', 'lib', 'ui', 'src',
]);

const DOMAIN_SUFFIX = /\.(com|org|net|io|dev|co|ai|app)$/i;

/**
 * deriveCodelineName('next.acme-store.com') -> 'acmestore'
 *
 * Keeps EVERY remaining word. Dropping words produces an identifier that no
 * longer identifies the repository, which is how a distinct repo can collide
 * with another or point at a worktree that does not exist.
 */
/**
 * deriveCodelineNames(parsed) — replace every model-supplied codeline name with one derived
 * from that codeline's own path.
 *
 * A codeline name is a PRIMARY KEY: it keys byCodeline, the KB stores, story.codelines,
 * project.outputDirs, the lane loop, and the per-codeline fix-site and verification-criteria
 * maps. It cannot come from a sample.
 *
 * The discovery prompt used to show the model a worked example of the convention. That example
 * was a client repository name, so it was replaced with a description of itself — correct for
 * the no-client-values rule, but the example was the only thing pinning the convention, and
 * the description admits more than one honest answer. The model produced 'gotransit' on one
 * run and 'nextgotransitcom' on the next.
 *
 * Live 2026-08-08 that cost a run: the mint wrote registries keyed one way, discovery re-ran
 * across the pause boundary and rewrote the PRD the other way, investigatorForCodeline
 * returned '' for every lane, and all three fell back to the generic detective — silently,
 * because a miss there is indistinguishable from "no investigator was minted".
 *
 * Both constraints hold this way: no client value goes into the prompt, and the model still
 * decides WHICH repositories are in scope and why — only the identifier is taken back. What
 * the model called it is preserved as `modelName` so a rename is visible rather than implicit.
 */
function deriveCodelineNames(parsed) {
  if (!parsed || !Array.isArray(parsed.codelines)) return parsed;
  return {
    ...parsed,
    codelines: parsed.codelines.map((cl) => {
      if (!cl || typeof cl !== 'object' || !cl.path) return cl;
      // basename of the checkout directory — trailing separators stripped, so a path written
      // with or without one yields the same identity.
      const dir = String(cl.path).replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
      const derived = deriveCodelineName(dir);
      if (!derived) return cl;
      return cl.name === derived
        ? cl
        : { ...cl, name: derived, modelName: cl.name };
    }),
  };
}

function deriveCodelineName(dirName) {
  const base = String(dirName || '').replace(DOMAIN_SUFFIX, '');
  const parts = base.split(/[.\-_\s]+/).filter(Boolean);

  // Strip decoration only while something identifying survives.
  const kept = [];
  for (const p of parts) {
    if (DECORATION.has(p.toLowerCase()) && parts.length > 1) continue;
    kept.push(p);
  }
  const words = kept.length ? kept : parts;

  const name = words.join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Never empty: an empty codeline name breaks every downstream lookup, so fall
  // back to the raw directory rather than returning something unusable.
  return name || String(dirName || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'codeline';
}

module.exports = { deriveCodelineName, deriveCodelineNames, DECORATION };
