#!/usr/bin/env node
'use strict';
/**
 * agent-output-schema.js — does a tagged agent answer actually have the promised shape?
 *
 * Four structured contracts had no enforcement at all. SPEC_AGENT, SPEC_ASSIGNMENTS,
 * SPEC_REVIEW and MODEL_REVIEW each declare a JSON shape in prose and each pass a toolDef
 * to runAgentForJson — so they LOOK bound. But runAgentForJson has two paths, and the
 * direct-exec path simply tag-parses the model's text. Nothing checked the parsed object
 * conformed.
 *
 * LIVE COST (run 20260804T100335Z). The coordinator answered in prose —
 *   "I cannot write the final output yet — I must first verify the referenced file paths
 *    against the repository using my read-only tools."
 * — and emitted an EMPTY <SPEC_REVIEW></SPEC_REVIEW>. The parse returned null, the review
 * was discarded, and all three retries reproduced the identical prose because nothing told
 * the model it had failed. The spec-review gate downstream then guarded nothing. The one
 * lane that did answer scored 0.35 and flagged the case-variant filename risk — it had
 * found the real defect.
 *
 * WHY NOT PROVIDER-SIDE STRICT SCHEMA. gate_verdict_schema.py's docstring records it:
 * strict json_schema mode suppresses tool calling, and these reviewers now need tools to
 * check paths against the repository. Validating AFTER the call keeps the tools, refuses a
 * malformed answer anyway, and produces a REASON — so a retry can be told what was wrong
 * instead of merely being handed a bigger model.
 *
 * DESIGN RULES
 * - Unknown tags PASS. Refusing a shape this file has never heard of would break every
 *   agent added later; the registry is additive, not a gate on existence.
 * - null NEVER passes, known tag or not. No answer is no answer.
 * - Absent optional fields are valid. Absent is not invalid — a reviewer that omits an
 *   optional score has still reviewed.
 * - Every refusal carries a reason naming the offending value, because the reason is the
 *   only thing that makes attempt 2 different from attempt 1.
 *
 * Nothing here knows any project, codeline or vendor.
 */

const fail = (reason) => ({ ok: false, reason });
const pass = () => ({ ok: true, reason: null });

/** Shared: a non-empty array of objects. */
function requireEntries(value, tag) {
  if (!Array.isArray(value)) return fail(`${tag}: expected an array of entries, got ${typeof value}`);
  if (!value.length) return fail(`${tag}: the array is empty — a report about nothing is not a report`);
  return null;
}

function checkSpecReview(value) {
  const bad = requireEntries(value, 'SPEC_REVIEW');
  if (bad) return bad;
  const allowed = ['approved', 'needs_review'];
  for (const e of value) {
    if (!e || typeof e !== 'object') return fail('SPEC_REVIEW: an entry is not an object');
    if (!e.storyId) return fail('SPEC_REVIEW: an entry has no storyId — a verdict about nothing cannot be applied');
    if (!e.verdict) return fail(`SPEC_REVIEW: story ${e.storyId} has no verdict`);
    if (!allowed.includes(e.verdict)) {
      return fail(`SPEC_REVIEW: story ${e.storyId} has verdict "${e.verdict}" — expected one of ${allowed.join(', ')}`);
    }
    if (e.qualityScore !== undefined && e.qualityScore !== null) {
      const q = e.qualityScore;
      if (typeof q !== 'number' || Number.isNaN(q) || q < 0 || q > 1) {
        return fail(`SPEC_REVIEW: story ${e.storyId} has qualityScore ${q} — expected a number between 0 and 1`);
      }
    }
  }
  return pass();
}

function checkSpecAssignments(value) {
  const bad = requireEntries(value, 'SPEC_ASSIGNMENTS');
  if (bad) return bad;
  for (const e of value) {
    if (!e || typeof e !== 'object') return fail('SPEC_ASSIGNMENTS: an entry is not an object');
    if (!e.storyId) return fail('SPEC_ASSIGNMENTS: an entry has no storyId');
    if (!e.agentRole) return fail(`SPEC_ASSIGNMENTS: story ${e.storyId} has no agentRole — nothing can be dispatched`);
  }
  return pass();
}

function checkModelReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('MODEL_REVIEW: expected an object with a verdict');
  }
  if (!value.verdict) return fail('MODEL_REVIEW: no verdict field');
  return pass();
}

function checkSpecAgent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('SPEC_AGENT: expected an object payload, got ' + (value === null ? 'null' : typeof value));
  }
  return pass();
}

const REGISTRY = {
  SPEC_REVIEW: checkSpecReview,
  SPEC_ASSIGNMENTS: checkSpecAssignments,
  MODEL_REVIEW: checkModelReview,
  SPEC_AGENT: checkSpecAgent,
};

/**
 * validateTaggedOutput(tag, parsed) -> { ok, reason }
 *
 * `parsed` is whatever extractTaggedJson produced — null when the tag was missing, empty
 * or unparseable, which is the live failure this exists to catch.
 */
function validateTaggedOutput(tag, parsed) {
  if (parsed === null || parsed === undefined) {
    return fail(`${tag}: no parseable output — the tag was missing, empty, or contained prose instead of JSON`);
  }
  const check = REGISTRY[tag];
  if (!check) return pass(); // additive registry: an unknown tag is not an error
  return check(parsed);
}

module.exports = { validateTaggedOutput, REGISTRY };
