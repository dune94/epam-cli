/**
 * seam-invocation — the model settings a seam is configured to run with.
 *
 * WHICH seam climbs WHICH ladder is data: agents/invocation-profiles.json names a ladder per
 * seam. WHAT models a ladder contains is the project's, as EPAM_MODEL_LADDER_<NAME> in its own
 * config. No seam, ladder or model name appears here — changing either is an edit to a registry
 * or a project, never to the engine.
 *
 * A seam with no entry gets {} and runs on whatever the run already provides. Nothing is bound
 * implicitly, and a named ladder with no models configured warns rather than inventing one.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function registryPath(agentsDir) {
  if (process.env.AGENT_PROFILES_REGISTRY) return process.env.AGENT_PROFILES_REGISTRY;
  const dir = agentsDir || path.join(__dirname, '..', '..', 'agents');
  return path.join(dir, 'invocation-profiles.json');
}

function seamInvocationEnv(seam, agentsDir) {
  if (!seam) return {};
  let profile = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(agentsDir), 'utf8'));
    profile = (parsed.profiles || {})[seam] || null;
  } catch { return {}; }
  if (!profile) return {};

  const env = {};
  if (profile.reasoningEffort) env.EPAM_REASONING_EFFORT = String(profile.reasoningEffort);
  if (profile.temperature !== undefined && profile.temperature !== '') {
    env.EPAM_TEMPERATURE = String(profile.temperature);
  }
  if (profile.ladder) {
    const key = 'EPAM_MODEL_LADDER_' + String(profile.ladder).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const rungs = process.env[key];
    if (rungs) {
      env.EPAM_MODEL_LADDER_HIGH = rungs;
      env.EPAM_MODEL_LADDER = rungs;
      // The first rung is where this seam STARTS. Without it the seam begins on the run's
      // default model and the ladder only governs where it escalates to.
      const first = String(rungs).split('|')[0].split('=')[0].trim();
      if (first) env.EPAM_MODEL = first;
    } else {
      process.stderr.write(
        `[seam-invocation] seam '${seam}' asks for ladder '${profile.ladder}' but ${key} is unset — ` +
        'using the run\'s default ladder\n');
    }
  }
  return env;
}

module.exports = { seamInvocationEnv, registryPath };
