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
  // Ticket links enter an EVIDENCE path — a prose answer cannot be persisted or acted on.
  TICKET_LINKS: { tool: 'TOOL_TICKET_LINKS', itemsKey: 'links' },

  // THE FOUR THAT WERE BOUND AND NEVER VALIDATED.
  //
  // The runner binds nine tags; this map held six. For the missing four, validateTaggedOutput()
  // returned ok:true for ANY payload — so four seams that all run before pause 1 had a schema
  // declared at the invocation and no check behind it. Found 2026-08-24 by replaying a killed
  // run's own replies: ROSTER_REVIEW answered `"verdict": "warn"`, a value its enum forbids, and
  // nothing objected.
  //
  // itemsKey names the ARRAY whose items are checked; null means the payload itself is the
  // object. A verdict-carrying payload is the object, so its top-level fields are what matter.
  ESTATE_SURVEY: { tool: 'TOOL_ESTATE_SURVEY', itemsKey: null },
  PROJECT_AGENTS: { tool: 'TOOL_PROJECT_AGENTS', itemsKey: 'proposedAgents' },
  ROSTER_REVIEW: { tool: 'TOOL_ROSTER_REVIEW', itemsKey: null },
  ROLE_ASSIGNMENTS: { tool: 'TOOL_ROLE_ASSIGNMENTS', itemsKey: 'assignments' },
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

/**
 * A DECLARED VOCABULARY IS PART OF THE CONTRACT.
 *
 * The type check accepted `verdict: "warn"` because `warn` is a string, and the tool's
 * `enum: [sound, defects_found, nothing_to_review]` was never consulted. A gate that reads the
 * verdict then has to guess what an unlisted value means, and every such guess so far has
 * resolved toward "pass". Only fires where a schema actually states an enum.
 */
const enumOk = (v, schema) => !Array.isArray(schema && schema.enum) || !schema.enum.length
  || schema.enum.includes(v);

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
    // ACs ARE NOT IN SCOPE IN BROWNFIELD. The AC gate skips acceptance-criteria processing
    // for a brownfield ticket entirely and records that verification criteria come from the
    // description instead, so a brownfield answer legitimately has none. Demanding the field
    // flagged every brownfield SPEC_AGENT answer on every run — noise today, and fatal the
    // moment EPAM_SCHEMA_STRICT=1 is switched on, which is the whole point of this file.
    if (key === 'acceptanceCriteria' && process.env.EPAM_BROWNFIELD === '1') continue;
    const v = item[key];
    // AN EMPTY ARRAY IS PRESENT, NOT MISSING.
    //
    // `required` means the key is there. This treated `findings: []` as absent, so the ONE answer
    // a sound review is supposed to give — "I examined it and found nothing" — failed validation
    // the moment ROSTER_REVIEW was actually mapped. The roster-review prompt says so in as many
    // words: "An empty finding list from a review that RAN is the correct answer for a sound
    // roster." Emptiness that genuinely means nothing-was-done is caught where it belongs: the
    // top-level array branch above refuses an empty report outright, and the verdict rules in
    // spec-mode-runner refuse defects_found with no findings.
    if (v === undefined || v === null || v === '') {
      const id = item.storyId ? ` (story ${item.storyId})` : '';
      return fail(`${where}${id}: missing required field "${key}" — required by its own tool definition`);
    }
    const declared = (schema.properties || {})[key];
    if (declared && !enumOk(v, declared)) {
      return fail(`${where}: field "${key}" is ${JSON.stringify(v)}, which its tool definition `
        + `does not allow — declared values are: ${declared.enum.join(', ')}`);
    }
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

  // THE WRAPPER. A tag with an itemsKey declares its answer as an OBJECT holding an array
  // — TOOL_TICKET_LINKS is `{ required: ['links'], properties: { links: [...] } }` — and a
  // model that answers in exactly the declared shape returns that object. This branch used
  // to hand the wrapper straight to checkItem against the ITEM schema, so it looked for
  // `url` on `{links: [...]}` and refused every correctly-shaped answer with
  // 'missing required field "url"'. Diagnostic-only refusals hid it: the warning printed on
  // every single call and the payload flowed anyway. Under EPAM_SCHEMA_STRICT=1 — the mode
  // this file exists to make reachable — it would have dropped valid work on four tags.
  const itemsKey = (TAG_TO_TOOL[tag] || {}).itemsKey;
  if (itemsKey && parsed && typeof parsed === 'object' && Array.isArray(parsed[itemsKey])) {
    const items = parsed[itemsKey];
    if (!items.length) return fail(`${tag}: "${itemsKey}" is empty — a report about nothing is not a report`);
    for (let i = 0; i < items.length; i += 1) {
      const r = checkItem(items[i], schema, tag, i);
      if (!r.ok) return r;
    }
    return pass();
  }
  return checkItem(parsed, schema, tag, null);
}


/**
 * validateDeclaredOutput(seam, parsed) — the contract for seams whose shape is DECLARED rather
 * than bound to a tool schema.
 *
 * Eleven seams had nothing checking their output at all. A bad answer from any of them flowed
 * on looking authoritative — the same class that let the roster-specialiser's prose ("I need to
 * create a valid JSON file. Let me fix the formatting:") reach a contract check on a paid run.
 *
 * The required keys come from config/seam-output-contracts.json, which takes them from the shape
 * the seam's PROMPT already states — so the contract and the prompt cannot drift apart. Only the
 * key a consumer cannot proceed without is required: demanding every optional field would reject
 * valid answers, and the defect being caught is an answer that is not the artefact at all.
 *
 * NOTE ON WHERE THE PROMPT LIVES. An agent runs its PROJECT's generated copy, not the template.
 * A separate test holds the generator to the template's shape; this function validates the reply.
 */
function declaredContracts() {
  const fs = require('fs');
  const path = require('path');
  const file = process.env.EPAM_SEAM_CONTRACTS
    || path.join(__dirname, '..', '..', 'config', 'seam-output-contracts.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).seams || {}; } catch { return {}; }
}

function validateDeclaredOutput(seam, parsed) {
  const c = declaredContracts()[seam];
  if (!c || c.kind !== 'declared') {
    return { ok: true, reason: '', declared: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      declared: true,
      fatal: true,
      reason: `${seam}: expected a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}. `
        + 'An answer that is not the artefact is not a partial answer.',
    };
  }
  const missing = (c.requiredKeys || []).filter(
    (k) => !Object.prototype.hasOwnProperty.call(parsed, k));
  if (missing.length) {
    return {
      ok: false,
      declared: true,
      fatal: true,
      reason: `${seam}: the reply is missing ${missing.join(', ')} — the field(s) its consumer `
        + `reads. Its prompt states: ${(c.knownKeys || []).join(', ')}`,
    };
  }
  return { ok: true, reason: '', declared: true };
}

module.exports = { validateTaggedOutput, validateDeclaredOutput, declaredContracts, TAG_TO_TOOL, itemSchemaFor };
