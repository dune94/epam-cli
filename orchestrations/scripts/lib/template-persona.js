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
  // The seams that render this template: the registry's `template` for a seam, and the template's
  // own `seams` declaration (a seam may render several templates — the writer's main prompt, the
  // speckit author, the post-phase assessment).
  let declared = [];
  try {
    // eslint-disable-next-line global-require
    const { templatePathFor } = require('./engine-prompt.js');
    declared = JSON.parse(fs.readFileSync(templatePathFor(templateId), 'utf8')).seams || [];
  } catch { declared = []; }
  const seams = Object.keys(profiles).filter((k) => profiles[k] && (profiles[k].template === templateId || declared.includes(k)));
  const who = [...new Set(seams.map((k) => profiles[k].persona).filter(Boolean))];
  if (who.length !== 1) return undefined;
  // eslint-disable-next-line global-require
  const text = require('./agent-roster.js').agentPersona(who[0], agentsDir, env.EPAM_PROJECT_CONFIG_DIR);
  return text && String(text).trim() ? String(text) : undefined;
}

module.exports = { templatePersona, SLOT: '__PERSONA__' };
