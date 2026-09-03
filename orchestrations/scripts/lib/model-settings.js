/**
 * model-settings.js — the ladder's per-model settings, resolved ONCE.
 *
 * THE LADDER DEFINES ITERATIONS. An agent is assigned to a ladder position; the rung it
 * resolves to owns the budget. Operator rule, 2026-08-21.
 *
 * This resolution existed only as ~20 lines of inline jq inside claude.sh's per-attempt
 * STORY invocation path. Every other caller — every seam — therefore could not reach it:
 * seam-invocation.js set EPAM_MAX_ITERATIONS from a per-agent literal instead, 22 profiles
 * carried one, 16 carried none and fell through to `defaults.maxIterations` of 1.
 *
 * The matching rule is the project's, not this file's. An entry declares how it matches:
 *
 *   { "matchOn": "provider", "matchValue": "openrouter",     ... }
 *   { "matchOn": "model",    "matchSubstring": "M3",   ... }
 *
 * DECLARATION ORDER, FIRST MATCH WINS — so MiniMax-M2.5 and MiniMax-M3 can carry different
 * budgets despite sharing a provider. That ordering is the contract claude.sh already
 * relies on; changing it here would change which budget a story gets.
 *
 * Nothing in this file names a model, a provider, a project or a number.
 */

'use strict';

const fs = require('fs');

/**
 * modelOverridesFor(model, provider, settingsFile) -> object | null
 *
 * The first declared override matching this model/provider, or null when none matches.
 * Null means "the project declares nothing for this rung" — never a default, because a
 * default invented here is exactly the per-site literal this file exists to remove.
 */
function modelOverridesFor(model, provider, settingsFile) {
  if (!settingsFile) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    return null; // an unreadable settings file is the loader's business to report, not ours
  }
  const overrides = (doc && doc.modelOverrides) || {};
  const m = String(model || '');
  const p = String(provider || '');

  for (const key of Object.keys(overrides)) {
    const o = overrides[key];
    if (!o || typeof o !== 'object') continue;
    if (o.matchOn === 'provider' && o.matchValue != null && String(o.matchValue) === p) return o;
    if (o.matchOn === 'model' && o.matchSubstring != null && m.includes(String(o.matchSubstring))) return o;
  }
  return null;
}

/**
 * maxIterationsFor(model, provider, settingsFile) -> number | null
 *
 * Null when the project declares no budget for this rung. The caller states that gap; it
 * does not fill it. A seam silently given someone else's number is how a run spends a
 * budget nobody chose.
 */
function maxIterationsFor(model, provider, settingsFile) {
  const o = modelOverridesFor(model, provider, settingsFile);
  const n = o && o.maxIterations;
  return Number.isFinite(n) ? n : null;
}

/**
 * iterationMap(settingsFile) -> "matchSubstring=N|..." for shell consumers.
 *
 * Emitted by lib/model-ladders.sh so a shell seam can resolve the same budget from env
 * without re-reading the settings file or re-implementing the match. Provider-matched
 * entries are included as "provider:<value>=N".
 */
function iterationMap(settingsFile) {
  if (!settingsFile) return '';
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    return '';
  }
  const overrides = (doc && doc.modelOverrides) || {};
  const parts = [];
  for (const key of Object.keys(overrides)) {
    const o = overrides[key];
    if (!o || typeof o !== 'object' || !Number.isFinite(o.maxIterations)) continue;
    if (o.matchOn === 'model' && o.matchSubstring != null) {
      parts.push(String(o.matchSubstring) + '=' + o.maxIterations);
    } else if (o.matchOn === 'provider' && o.matchValue != null) {
      parts.push('provider:' + String(o.matchValue) + '=' + o.maxIterations);
    }
  }
  return parts.join('|');
}

module.exports = { modelOverridesFor, maxIterationsFor, iterationMap };
