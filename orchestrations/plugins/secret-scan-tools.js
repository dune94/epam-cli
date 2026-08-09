'use strict';

/**
 * secret-scan-tools — a credential check the REVIEWER calls, that knows what it is looking at.
 *
 * WHY THIS EXISTS. The commit-time scan matched `credential_name: value` on shape alone and
 * refused the commit for
 *
 *     management_token: CONTENTSTACK_LIVE_PREVIEW_TOKEN,
 *
 * an environment-derived identifier — the exact pattern its own error message recommends. On a
 * story whose entire purpose is wiring a preview token it would have blocked every commit, and
 * it had never caught a real leak. It was removed from the commit path on 2026-08-09 and the
 * check moved here, where the reviewer already holds the diff.
 *
 * THE DISTINCTION IS MECHANICAL, WHICH IS WHY IT BELONGS IN A TOOL:
 *
 *   LEAK       apiKey = "blt9f2c…"                 quoted, long, high entropy
 *   REFERENCE  management_token: SOME_CONSTANT     an identifier
 *   REFERENCE  token = process.env.SOME_TOKEN      an env read
 *
 * A pasted credential is ALWAYS a literal, which is what makes the narrow rule safe: ignoring
 * identifiers cannot let a real key through.
 *
 * IT REPORTS, IT DOES NOT DECIDE. Findings go to the reviewer, which judges them with the rest
 * of the diff in view. Deterministic evidence, agent judgement, gate on the verdict — the
 * ordering that works. A heuristic deciding alone is what blocked correct work.
 *
 * NO PROJECT, STACK OR VENDOR VOCABULARY. The subjects are whatever names appear in the diff;
 * the verdict is entropy and syntax.
 */

// A SEMVER STRING, like every other plugin. Declared as the number 1, validatePlugin's
// `pluginApiVersion.split('.')` threw, the whole plugin failed to load, and scan_secrets was
// never available to any reviewer — visible only as one warning line inside an agent log.
const PLUGIN_API_VERSION = '1.0.0';

// Names that make a value worth examining. This is a property of the WORD, not of any project —
// a variable called `token` means the same thing in every codebase.
const SECRETISH = /(pass(word|wd)?|secret|token|api[_-]?key|apikey|access[_-]?key|credential|private[_-]?key|auth)/i;

// Explicit not-real markers. Deliberately narrow: a real key never says it is fake.
const PLACEHOLDER = /(dummy|not-?a?-?real|fake|placeholder|changeme|example|your[_-]|xxxx|<[^>]+>|\.\.\.)/i;

/** Shannon entropy per character — a pasted key is high, a word is low. */
function entropy(s) {
  if (!s.length) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * The right-hand side of an assignment, and whether it is a LITERAL.
 *
 * Only a quoted literal can carry a credential. An identifier, a member expression, a call and
 * a template referencing something else are all references to a value held elsewhere — which is
 * the practice being recommended, not a leak.
 */
function literalValue(rhs) {
  const m = String(rhs).trim().match(/^(['"`])([^'"`]*)\1/);
  return m ? m[2] : null;
}

function findingsFor(diff) {
  const out = [];
  const lines = String(diff || '').split('\n');
  for (const raw of lines) {
    // Added lines only. A removed credential is being taken OUT, which is the fix, not the leak.
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);

    // `name: value` or `name = value`, where the name is credential-ish.
    const m = line.match(/([A-Za-z_$][\w$]*)\s*[:=]\s*(.+)$/);
    if (!m) continue;
    const [, name, rhs] = m;
    if (!SECRETISH.test(name)) continue;

    const value = literalValue(rhs);
    if (value === null) continue;                       // a reference, not a literal — the point
    if (value.length < 12) continue;                    // too short to be a key
    if (PLACEHOLDER.test(value)) continue;              // says outright that it is not real

    const h = entropy(value);
    if (h < 3.0) continue;                              // prose, a path, a word — not a key

    out.push({
      line: line.trim(),
      name,
      reason:
        `a quoted literal of ${value.length} chars with entropy ${h.toFixed(2)} is assigned to ` +
        `'${name}' — a pasted credential looks like this; a reference to one does not`,
    });
  }
  return out;
}

const scanSecretsTool = {
  name: 'scan_secrets',
  pluginApiVersion: PLUGIN_API_VERSION,
  description:
    'Examine a diff for credentials that have been PASTED INTO the code, and report them. ' +
    'Distinguishes a literal (a quoted, long, high-entropy value — what a leaked key looks ' +
    'like) from a reference (an identifier, a member expression, a process.env read — which ' +
    'is the correct practice and is never reported). Returns findings for you to judge; it ' +
    'does not block anything.',
  permission: 'safe',
  definition: {
    name: 'scan_secrets',
    description: 'Report credentials pasted as literals in a diff. References are not findings.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'Unified diff to examine. Only ADDED lines are considered.',
        },
      },
      required: ['diff'],
    },
  },
  async execute(input) {
    try {
      return JSON.stringify({ findings: findingsFor(input && input.diff) }, null, 2);
    } catch (err) {
      // A scanner that throws must not look like a scanner that found nothing.
      return JSON.stringify({ findings: [], error: String((err && err.message) || err) }, null, 2);
    }
  },
};

module.exports = { tools: [scanSecretsTool], findingsFor, entropy };
