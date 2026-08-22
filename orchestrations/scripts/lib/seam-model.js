#!/usr/bin/env node
/**
 * RESOLVE A SEAM'S MODEL, OR REFUSE. Never substitute one nobody configured.
 *
 * Four JS seams ended `|| 'z-ai/glm-5.2'` and one `|| 'minimax'`. A literal in that position is
 * unreachable by configuration: the project declares its models, the operator overrides them,
 * and the seam quietly runs something else anyway when the wiring that should have supplied one
 * is broken. The result reads as authoritative — a gate verdict, a routing decision, an AC
 * classification — with nothing to say it was produced by a model the run never chose.
 *
 * This is the JS half of the idiom agent-attempt-analyst.sh and brownfield-repro-test-writer.sh
 * already use: "no model resolved for this seam" and stop. Failing here is loud, immediate and
 * fixable. Substituting is silent and only visible in a bill.
 */
'use strict';

/**
 * @param {object} opts
 *   sources  ordered candidate values, first non-empty wins (argv, then env)
 *   seam     name used in the failure message
 *   what     'model' | 'provider' — what could not be resolved
 * @returns {string} the resolved value
 * @throws  when nothing resolves — deliberately, see above
 */
function resolveOrRefuse({ sources, seam, what = 'model' }) {
  for (const s of sources || []) {
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  const err = new Error(
    `[${seam}] no ${what} resolved for this seam. Its ladder declares none, or the tier's chain `
    + `is unset. Refusing to substitute one: a result produced by a ${what} nothing configured `
    + `reads as authoritative and cannot be traced to a declared tier.`);
  err.code = 'ESEAMMODEL';
  throw err;
}

module.exports = { resolveOrRefuse };
