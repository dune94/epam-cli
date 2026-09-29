'use strict';
/**
 * THE PERSONA A TEMPLATE'S `__PERSONA__` SLOT CARRIES — read from the seam that renders it.
 *
 * A seam declares whose persona it speaks as (agents/invocation-profiles.json `persona`) and which
 * template it renders (`template`). A template carries the agent's identity in one slot,
 * `__PERSONA__`, and both renderers (engine-prompt.js, prompt-library.js) fill it from here when the
 * caller supplies none — so the identity is written once, in the profiles, and reaches the model on
 * every stack: the prompt everywhere, and the codemie-web assistant's system instructions as well.
 *
 * The persona text is the pipeline's own (agent-roster.js agentPersona): the project roster's once it
 * carries the agent, the install's profiles before. A template several seams render with different
 * personas has no single answer: undefined, and the caller supplies it.
 */
const fs = require('fs');
const path = require('path');

function templatePersona(templateId, env = process.env) {
  if (!templateId) return undefined;
  const agentsDir = env.EPAM_AGENTS_DIR || path.join(__dirname, '..', '..', 'agents');
  // eslint-disable-next-line global-require
  const { registryPath } = require('./seam-invocation.js');
  let profiles;
  try { profiles = JSON.parse(fs.readFileSync(registryPath(agentsDir), 'utf8')).profiles || {}; } catch { return undefined; }
  const who = [...new Set(Object.values(profiles)
    .filter((p) => p && p.template === templateId && p.persona)
    .map((p) => p.persona))];
  if (who.length !== 1) return undefined;
  // eslint-disable-next-line global-require
  const text = require('./agent-roster.js').agentPersona(who[0], agentsDir, env.EPAM_PROJECT_CONFIG_DIR);
  return text && String(text).trim() ? String(text) : undefined;
}

module.exports = { templatePersona, SLOT: '__PERSONA__' };
