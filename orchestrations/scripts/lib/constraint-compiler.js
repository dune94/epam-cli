/**
 * constraint-compiler.js — PILLAR 3. Turn stored constraints into enforcement.
 *
 * The rule this module exists to make true: **healed knowledge never reaches an
 * agent as prose.** Today's path ends in COORDINATOR_PROMPT_AMENDMENT — text
 * appended to a prompt, silently trimmed to the last three headings past ~16000
 * chars, with nothing checking the agent obeyed it. Role KBs are worse: the read
 * path is `tail -n 20` then `tail -n 10`, so at most ten lines of accumulated
 * knowledge ever reach an agent. Instruction softening there is not a risk, it is
 * the mechanism.
 *
 * A compiled constraint becomes one of exactly three things the agent cannot argue
 * with:
 *
 *   param      -> a validated field in the invocation registry (agent-invoke.sh),
 *                 already the single door every LLM call passes through
 *   tool_scope -> narrowed EPAM_ALLOWED_WRITE_PATHS / EPAM_ALLOWED_TOOLS
 *   gate       -> a deterministic check in the gate chain, adjudicated by
 *                 tsc/vitest and failing closed
 *
 * `compile()` is deliberately TOTAL over the schema's enforcement kinds and throws
 * on anything else. That is the admission rule stated as code: knowledge we cannot
 * enforce is knowledge we decline to hold. The compiler test derives the kind list
 * from kb_schema.py itself, so adding a kind without a branch here fails the suite.
 *
 * SAFETY: scope constraints INTERSECT, never union. A heal must not be able to
 * grant an agent more reach than it already had — self-healing that can widen its
 * own permissions is a privilege-escalation path, not a fix.
 */
'use strict';

const SUPPORTED = ['gate', 'param', 'tool_scope'];

const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/**
 * @param {Array} constraints  records already validated by kb_schema.py
 * @returns {{env: Object<string,string>, gates: string[]}}
 *   Deliberately has NO free-text field — there is no channel by which a
 *   constraint can degrade back into advice.
 */
function compile(constraints) {
  const env = {};
  const gates = [];
  const scopes = { EPAM_ALLOWED_WRITE_PATHS: null, EPAM_ALLOWED_TOOLS: null };

  for (const c of constraints || []) {
    if (c.status === 'archived') continue;
    const e = c.enforcement || {};
    if (!SUPPORTED.includes(e.kind)) {
      throw new Error(
        `constraint-compiler: cannot compile enforcement kind '${e.kind}' (constraint '${c.id}'). ` +
        `Supported: ${SUPPORTED.join(', ')}. A constraint with no mechanism must not be stored.`);
    }
    switch (e.kind) {
      case 'gate':
        if (!gates.includes(e.check)) gates.push(e.check);
        break;
      case 'param':
        env[e.name] = String(e.value);
        break;
      case 'tool_scope':
        // Intersect: the narrowest constraint wins. Never widen.
        for (const [key, field] of [
          ['EPAM_ALLOWED_WRITE_PATHS', 'allowed_write_paths'],
          ['EPAM_ALLOWED_TOOLS', 'allowed_tools'],
        ]) {
          if (!e[field]) continue;
          const incoming = csv(e[field]);
          scopes[key] = scopes[key] === null
            ? incoming
            : scopes[key].filter(x => incoming.includes(x));
        }
        break;
    }
  }

  for (const [key, list] of Object.entries(scopes)) {
    if (list && list.length) env[key] = list.join(',');
  }
  return { env, gates };
}

const supportedKinds = () => SUPPORTED.slice();

module.exports = { compile, supportedKinds };
