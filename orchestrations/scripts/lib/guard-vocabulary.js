// guard-vocabulary.js — the terms a deterministic guard checks are DERIVED, never written down.
//
// WHY THIS EXISTS
// ---------------
// Every guard in this pipeline encoded its checks as a literal list in engine code, and
// each list was reverse-engineered from one past incident:
//
//   VC_MECHANISM_PATTERNS     6 regexes from 5 sentences in one fare-discount bug,
//                             carrying client-domain nouns (segment, leg, line-item)
//   VC_OBSERVABILITY_RULES    the same 5 sentences again, as prose examples
//   vc-guard-and-loop.test.ts the same 5 sentences again, as the test fixture — which is
//                             why the guard could never fail and nobody noticed
//   PRESCRIPTIVE_AC_PATTERNS  11 regexes naming specific JS test libraries
//   SYMPTOM_STOPWORDS         presentation nouns from the same incident
//
// A list catches exactly the incident it was built from and nothing else. Worse, it turns
// "unchecked" into "checked": the run log shows a clean guard, and nobody looks again. The
// live proof — two VCs prescribing mechanism ("the SDK is initialized and its callback is
// registered", "the initialization call includes the correct stack details") sailed through
// a guard whose entire vocabulary was about splitting and halving.
//
// THE RULE (project-level, not negotiable): a deterministic guard may be deterministic in
// ENFORCEMENT and REPRODUCIBILITY. Its CONTENT may never be hardcoded — not in engine code,
// not in config, not as a "generic" list somebody promises to maintain. A list is a list.
//
// THE SHAPE
//   1. The guard's rule is stated as a principle (what it means to violate), naming no
//      domain and no incident.
//   2. THIS agent derives, for THIS story, the concrete terms that would violate it —
//      grounded in real evidence (the detective's actual file reads), not ticket prose.
//   3. Output is SCHEMA-BOUND (see TOOL_GUARD_VOCABULARY). Prose is refused; the model must
//      fill a structured shape, so the result is machine-usable without parsing narrative.
//   4. The result is PERSISTED so a re-run applies the identical vocabulary — derivation is
//      agentic, enforcement is reproducible.
//   5. The guard becomes a pure applier holding no content of its own. Reading it end to end
//      teaches you nothing about any client, domain, or language.
//
// FAILS LOUD. If derivation fails, the guard has nothing to apply and must say so. "Found
// nothing" and "checked nothing" returning the same empty result is exactly what hid the old
// guards' uselessness for months.

'use strict';

/**
 * Schema for a derived guard vocabulary. Deliberately two lists and nothing else:
 * every guard in this pipeline reduces to "these terms violate the rule" (blacklist)
 * and "these terms are the legitimate observable surface" (whitelist).
 *
 * `reason` is per-term, not free narrative — it is what the guard reports when it
 * flags, so a human sees WHY without the agent being able to answer in prose.
 */
const TOOL_GUARD_VOCABULARY = {
  name: 'submit_guard_vocabulary',
  description:
    'Submit the concrete terms that would VIOLATE the stated guard rule for this story, ' +
    'and the terms that represent its legitimate observable surface. Derive them from the ' +
    'supplied code evidence. Do not answer in prose.',
  parameters: {
    type: 'object',
    required: ['blacklist', 'whitelist'],
    properties: {
      blacklist: {
        type: 'array',
        description: 'Terms/phrases whose presence indicates a violation of the rule.',
        items: {
          type: 'object',
          required: ['term', 'reason'],
          properties: {
            term: { type: 'string', description: 'The literal term or phrase to match, lowercase.' },
            reason: { type: 'string', description: 'Short clause naming which part of the rule it breaks.' },
            kind: {
              type: 'string',
              enum: ['implementation_noun', 'construction_verb', 'internal_structure', 'cross_comparison', 'other'],
            },
          },
        },
      },
      whitelist: {
        type: 'array',
        description: 'Terms naming the observable surface this story is about — never flagged.',
        items: {
          type: 'object',
          required: ['term'],
          properties: {
            term: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

/** Normalise for comparison. Kept here so applier and deriver cannot drift apart. */
function _norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * normaliseVocabulary(payload) -> { blacklist:[{term,reason,kind}], whitelist:[{term,reason}] }
 * A malformed payload yields empty lists — callers MUST treat that as "not derived"
 * and fail loud rather than as "nothing to flag".
 */
function normaliseVocabulary(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const list = (arr, extra) =>
    (Array.isArray(arr) ? arr : [])
      .map((e) => {
        const term = _norm(e && e.term);
        if (!term) return null;
        const out = { term, reason: String((e && e.reason) || '').trim() };
        if (extra && e && e.kind) out.kind = String(e.kind);
        return out;
      })
      .filter(Boolean);
  // Dedupe on term; first occurrence wins so the agent's ordering is preserved.
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((e) => (seen.has(e.term) ? false : (seen.add(e.term), true)));
  };
  return {
    blacklist: dedupe(list(src.blacklist, true)),
    whitelist: dedupe(list(src.whitelist, false)),
  };
}

/**
 * isVocabularyUsable(v) — a vocabulary with no blacklist cannot flag anything. Callers use
 * this to distinguish "derived, and this story genuinely has no violating terms" from
 * "derivation failed", which must never look the same.
 */
function isVocabularyUsable(v) {
  return !!(v && Array.isArray(v.blacklist) && v.blacklist.length > 0);
}

/**
 * applyVocabulary(items, vocabulary) -> [{ item, term, reason, kind }]
 *
 * THE PURE APPLIER. Holds no terms, no patterns, no domain nouns, no language or stack
 * assumptions. It matches whole words so a blacklisted term cannot fire on a substring of
 * an unrelated word, and a whitelisted term always wins — the observable surface a story is
 * about will often contain a word that is implementation detail elsewhere.
 */
function applyVocabulary(items, vocabulary) {
  const v = vocabulary && typeof vocabulary === 'object' ? vocabulary : {};
  const black = Array.isArray(v.blacklist) ? v.blacklist : [];
  const white = (Array.isArray(v.whitelist) ? v.whitelist : []).map((w) => w.term);
  const flagged = [];

  const contains = (haystack, term) => {
    if (!term) return false;
    // Whole-term match, punctuation-tolerant at the boundaries. Built from the term at
    // match time — nothing is precompiled into this file.
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(haystack);
  };

  for (const item of Array.isArray(items) ? items : []) {
    const text = _norm(item);
    if (!text) continue;
    if (white.some((w) => contains(text, w))) continue;
    const hit = black.find((b) => contains(text, b.term));
    if (hit) flagged.push({ item, term: hit.term, reason: hit.reason, kind: hit.kind });
  }
  return flagged;
}

module.exports = {
  TOOL_GUARD_VOCABULARY,
  normaliseVocabulary,
  isVocabularyUsable,
  applyVocabulary,
};
