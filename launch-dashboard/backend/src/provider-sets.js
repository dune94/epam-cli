/**
 * provider-sets.js — the picker's source of truth.
 *
 * Reads orchestrations/config/provider-sets.json (mounted read-only into this container as
 * PROVIDER_SETS_FILE) so a set added there needs no dashboard code change to become selectable.
 * NEVER a hardcoded list of names: the whole point is that a 5th set added upstream shows up here
 * for free.
 *
 * Read once and cached: it changes only when someone edits the config file and restarts the
 * container, and every request re-reading it from disk would be needless I/O on the hot path.
 */
import fs from 'node:fs';

let cache = null;
let cacheFile = null;

/** Read+parse a provider-sets.json file. Exposed directly (not cached) so tests can point it at
 * an arbitrary fixture without touching process.env. Fails LOUDLY: an unreadable or malformed
 * file must never present as an empty, silently-accepted list — that is how a misconfigured mount
 * would look identical to "no provider sets exist yet".
 */
function loadProviderSets(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`could not read provider-sets.json at ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`provider-sets.json at ${file} is not valid JSON: ${e.message}`);
  }
  const sets = parsed && typeof parsed === 'object' ? parsed.sets : null;
  if (!sets || typeof sets !== 'object') {
    throw new Error(`provider-sets.json at ${file} has no "sets" object`);
  }
  return Object.entries(sets).map(([name, cfg]) => ({
    name,
    description: (cfg && cfg.description) || '',
  }));
}

function resolveFile() {
  return process.env.PROVIDER_SETS_FILE || '/orchestrations-config/provider-sets.json';
}

/** Cached list, from PROVIDER_SETS_FILE. */
function listProviderSets() {
  const file = resolveFile();
  if (cache && cacheFile === file) return cache;
  cache = loadProviderSets(file);
  cacheFile = file;
  return cache;
}

function isKnownProviderSet(name, file) {
  const list = file ? loadProviderSets(file) : listProviderSets();
  return list.some((s) => s.name === name);
}

export { loadProviderSets, listProviderSets, isKnownProviderSet };
