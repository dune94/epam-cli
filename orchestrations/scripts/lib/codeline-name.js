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

module.exports = { deriveCodelineName, DECORATION };
