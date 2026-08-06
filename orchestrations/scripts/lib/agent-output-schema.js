#!/usr/bin/env node
'use strict';
/**
 * agent-output-schema.js — does a tagged agent answer match the shape its OWN tool
 * definition declares?
 *
 * WHY THIS EXISTS. SPEC_AGENT, SPEC_ASSIGNMENTS, SPEC_REVIEW and MODEL_REVIEW each pass a
 * toolDef to runAgentForJson, so they LOOK bound. runAgentForJson has two paths, and the
 * direct-exec path simply tag-parses the model's text — nothing checked the parsed object
 * conformed. Live 2026-08-04 a reviewer answered in prose inside an empty
 * <SPEC_REVIEW></SPEC_REVIEW>; the parse returned null, the review was discarded, and all
 * three retries reproduced it because nothing told the model it had failed. The
 * spec-review gate downstream then guarded nothing.
 *
 * WHY IT IS DERIVED, NOT WRITTEN. The first version of this file hand-wrote the shapes and
 * was wrong on THREE of four within the hour: it required `agentRole` where the contract
 * says `agents`, `verdict` where MODEL_REVIEW says `finalModel`, and accepted any object
 * at all for SPEC_AGENT. It rejected VALID coordinator output on a live run — three
 * lanes, every attempt. A validator that restates a contract is a second copy that
 * drifts, and a drifted validator is worse than none: it fails work that was correct.
 *
 * So required fields and types come FROM the tool definitions (TOOL_DEFINITIONS, exported
 * by spec-mode-runner.js), which already carry JSON Schema. One source of truth: changing
 * a tool definition changes what is enforced, automatically.
 *
 * WHY NOT PROVIDER-SIDE STRICT SCHEMA. gate_verdict_schema.py records it — strict
 * json_schema mode SUPPRESSES TOOL CALLING, and these reviewers need tools to check paths
 * against the repository. Validating after the call keeps the tools, refuses a malformed
 * answer anyway, and yields a REASON, which is the only thing that makes attempt 2 differ
 * from attempt 1.
 *
 * DESIGN RULES
 * - Unknown tags PASS: refusing a shape never heard of would break every agent added
 *   later. The registry is additive, not a gate on existence.
 * - null NEVER passes, known tag or not. No answer is no answer.
 * - Only DECLARED-required fields are enforced. An absent optional field is valid.
 * - Every refusal names the tag, the story and the field, because the reason is what
 *   makes a retry different.
 *
 * Nothing here knows any project, codeline or vendor.
 */

// A REFUSAL IS DIAGNOSTIC, NOT FATAL, BY DEFAULT.
//
// An unproven validator in the fatal path killed two live runs in one hour: one demanded
// `agentRole` where the contract says `agents`; the next demanded
// SPEC_AGENT.acceptanceCriteria, which spec-mode-runner.js:1574 forces back to the
// ticket's immutable original "regardless of what openspec/speckit proposed" — a
// condition the pipeline recovers from by design. Two lanes HALTED on it.
//
// The blast radius of a WRONG validator exceeds the defect it guards. So a shape mismatch
// warns, records the reason, and lets the parsed object flow: the pipeline's own recovery
// decides. EPAM_SCHEMA_STRICT=1 opts into hard failure once a contract is proven.
//
// A null answer is ALWAYS fatal, strict or not — no answer is no answer, and that is the
// case the review failure actually was.
const fail = (reason, fatal = false) => ({
  ok: false,
  reason,
  fatal: fatal || process.env.EPAM_SCHEMA_STRICT === '1',
});
const pass = () => ({ ok: true, reason: null });

/**
 * Which tag carries which tool definition, and which property holds the item array.
 * extractTaggedJson returns the items the caller asked for, not the tool wrapper.
 */
const TAG_TO_TOOL = {
  SPEC_ASSIGNMENTS: { tool: 'TOOL_SPEC_ASSIGNMENTS', itemsKey: 'assignments' },
  SPEC_AGENT: { tool: 'TOOL_SPEC_AGENT', itemsKey: null },
  SPEC_REVIEW: { tool: 'TOOL_SPEC_REVIEW', itemsKey: 'items' },
  MODEL_REVIEW: { tool: 'TOOL_MODEL_REVIEW', itemsKey: 'items' },
  // The guard-vocabulary agent derives what a deterministic guard checks, so its
  // answer must be schema-bound: a prose reply leaves the guard with nothing to
  // apply, and an unvalidated one puts arbitrary text into an enforcement path.
  GUARD_VOCABULARY: { tool: 'TOOL_GUARD_VOCABULARY', itemsKey: null },
};

// Lazy + cached: this module is required BY spec-mode-runner.js, so the require must not
// run at load time. By the time a validation happens, the runner's exports are complete.
let _defs = null;
function toolDefs() {
  if (_defs) return _defs;
  try {
    _defs = require('../spec-mode-runner.js').TOOL_DEFINITIONS || {};
  } catch {
    _defs = {};
  }
  return _defs;
}

/** The schema ONE item of this tag must satisfy, read from the live tool definition. */
function itemSchemaFor(tag) {
  const map = TAG_TO_TOOL[tag];
  if (!map) return null;
  const def = toolDefs()[map.tool];
  const params = def && def.parameters;
  if (!params || !params.properties) return null;
  if (!map.itemsKey) return params;            // the payload IS the object (SPEC_AGENT)
  const arr = params.properties[map.itemsKey];
  return (arr && arr.items) || null;
}

const typeOk = (v, t) => {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && !Number.isNaN(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
};

function checkItem(item, schema, tag, index) {
  const where = index === null ? tag : `${tag}[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return fail(`${where}: expected an object, got ${item === null ? 'null' : typeof item}`);
  }
  for (const key of schema.required || []) {
    const v = item[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
      const id = item.storyId ? ` (story ${item.storyId})` : '';
      return fail(`${where}${id}: missing required field "${key}" — required by its own tool definition`);
    }
    const declared = (schema.properties || {})[key];
    if (declared && declared.type && !typeOk(v, declared.type)) {
      return fail(`${where}: field "${key}" should be ${declared.type}, got ${Array.isArray(v) ? 'array' : typeof v}`);
    }
  }
  return pass();
}

/**
 * validateTaggedOutput(tag, parsed) -> { ok, reason }
 * `parsed` is whatever extractTaggedJson produced — null when the tag was missing, empty,
 * or held prose instead of JSON, which is the live failure this exists to catch.
 */
function validateTaggedOutput(tag, parsed) {
  if (parsed === null || parsed === undefined) {
    return fail(`${tag}: no parseable output — the tag was missing, empty, or contained prose instead of JSON`, true);
  }
  const schema = itemSchemaFor(tag);
  if (!schema) return pass();  // unknown tag, or nothing declared to enforce

  if (Array.isArray(parsed)) {
    if (!parsed.length) return fail(`${tag}: the array is empty — a report about nothing is not a report`);
    for (let i = 0; i < parsed.length; i += 1) {
      const r = checkItem(parsed[i], schema, tag, i);
      if (!r.ok) return r;
    }
    return pass();
  }
  return checkItem(parsed, schema, tag, null);
}

module.exports = { validateTaggedOutput, TAG_TO_TOOL, itemSchemaFor };
