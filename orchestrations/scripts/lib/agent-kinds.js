/**
 * WHAT KINDS OF AGENT EXIST — read from the registry, held nowhere else.
 *
 * Two modules carried this as a literal and disagreed:
 *
 *   project-roster.js   const KINDS       = ['implementer', 'investigator', 'seam'];
 *   agent-roster.js     const AGENT_KINDS = ['implementer', 'investigator'];
 *
 * So a roster entry of kind "seam" validated in one and was an "unrecognised kind" in the other,
 * and which answer a run got depended on which module happened to look. A kind decides whether an
 * agent may own a story and author code; that is not a question the engine may hold two opinions
 * about, and adding a fourth kind should not be a hunt through engine code for every copy.
 *
 * The vocabulary now lives in invocation-profiles.json as `agentKinds`, beside the seams that use
 * it, and both modules answer from here.
 *
 * NO DEFAULT. A registry that declares no kinds is a broken install, and inventing the list here
 * would restore exactly the duplicate this file exists to remove — with the added property that
 * nobody would notice, because the invented list would agree with the one that was deleted.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY = path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json');

let _cache = new Map();

/**
 * @param {string} [registryFile] the registry to read; defaults to the engine's own
 * @returns {string[]} the declared kinds, in declaration order
 */
function agentKinds(registryFile) {
  const file = registryFile || DEFAULT_REGISTRY;
  if (_cache.has(file)) return _cache.get(file).slice();

  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `[agent-kinds] cannot read the seam registry at ${file}: ${(e && e.message) || e}. `
      + 'Which kinds of agent exist is declared there and nowhere else.');
  }

  const kinds = Array.isArray(reg.agentKinds)
    ? reg.agentKinds.map((k) => String(k || '').trim()).filter(Boolean)
    : [];

  if (!kinds.length) {
    throw new Error(
      `[agent-kinds] ${file} declares no agentKinds. Every roster entry names a kind and every `
      + 'validator checks it against this list, so an empty vocabulary rejects the entire roster. '
      + 'Declare them there rather than having this file assume them.');
  }

  _cache.set(file, kinds);
  return kinds.slice();
}

/**
 * WHICH MEMBERSHIP LIST MAKES AN AGENT WHICH KIND — `{kind: filename}`.
 *
 * kindOfAgent resolved this by POSITION (`AGENT_KINDS[0]` for project-roles, `[1]` for
 * project-investigators), so reordering the kind vocabulary would have silently changed what
 * every registered agent is. An ordering is not a mapping.
 *
 * A registry that declares none returns {} — this is an optional refinement, and a caller that
 * finds no mapping simply cannot resolve a kind from membership, which is a truthful answer.
 */
function kindMembership(registryFile) {
  const file = registryFile || DEFAULT_REGISTRY;
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const m = reg && reg.agentKindMembership;
  if (!m || typeof m !== 'object') return {};
  const out = {};
  for (const k of Object.keys(m)) if (m[k]) out[k] = String(m[k]);
  return out;
}

/** Test seam: the registry is read once per file, and a test may change it between reads. */
function _resetCache() { _cache = new Map(); }

module.exports = { agentKinds, kindMembership, _resetCache };
