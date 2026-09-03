/**
 * kb-synthesizer.js — turn repeated episodes into ONE enforceable constraint.
 *
 * This is the only place an LLM re-enters the self-heal loop, and it is safe to let
 * it back in for one reason: **its output space IS the enforcement space.** The
 * prompt carries the JSON Schema generated from kb_schema.py, and the reply is
 * validated by that same Pydantic model. A proposal with no mechanism is not
 * "rejected by a reviewer" — it fails to parse as a Constraint at all.
 *
 * Contrast the analyst this replaces: it is offered prd | tc | skill | kb | tool |
 * none, none of which patches code, so it answers `none` on 77 of 118 real
 * diagnoses and the pipeline does nothing. The menu, not the model, was the defect.
 *
 * A SINGLE FAILURE IS NOT KNOWLEDGE. Synthesis fires only on a repeat (threshold 2
 * by default). Promoting a transient error to a permanent rule is precisely the
 * drift this design exists to prevent, and it is cheaper to miss a rule than to
 * enforce a wrong one.
 *
 * REJECTION LEAVES NOTHING BEHIND. No partial write, no `[unreviewed-fallback]`
 * persistence of the kind run_failure_analyst performs after three reviewer
 * rejections. A write path that cannot say no is a drift generator.
 */
'use strict';

const { renderEngineTemplate } = require('./engine-prompt.js');

const path = require('path');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');
const arb = require('./kb-arbitration.js');

const SCRIPT_DIR = __dirname;

function pythonBin() {
  const venv = path.join(SCRIPT_DIR, '..', '.venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : 'python3';
}

/** The Constraint JSON Schema — the model's output contract, generated not written. */
let _schemaCache = null;
function constraintSchema() {
  if (_schemaCache) return _schemaCache;
  try {
    _schemaCache = execFileSync(pythonBin(),
      [path.join(SCRIPT_DIR, 'kb_schema.py'), 'json-schema', 'constraint'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch {
    _schemaCache = '';
  }
  return _schemaCache;
}

function buildPrompt({ agent_role, signature, episodes }) {
  const evidence = episodes
    .map((e, i) => `  ${i + 1}. [${e.signature || 'unkeyed'}] ${e.diagnosis || '(no diagnosis)'}`)
    .join('\n');

  // RENDERED FROM THE TEMPLATE LAYER. The schema is supplied WHOLE: it used to arrive
  // .slice(0, 4000)'d, and a JSON schema cut at a byte offset is not a schema — the model was
  // told its answer is validated against rules it had only a fragment of.
  return renderEngineTemplate('kb-enforcement-synthesis', {
    __EPISODE_COUNT__: String(episodes.length),
    __AGENT_ROLE__: agent_role,
    __SIGNATURE__: signature,
    __EVIDENCE__: evidence,
    __CONSTRAINT_SCHEMA__: constraintSchema(),
  });
}

/** Pull the first balanced {...} that parses. Models wrap JSON in prose. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Synthesise a constraint if this (role, signature) has repeated enough.
 * @returns the admitted constraint, or null (below threshold / refused / invalid).
 */
async function maybeSynthesize(store, {
  agent_role, signature, threshold, runner, model, provider,
} = {}) {
  const limit = Number(threshold ?? process.env.KB_SYNTHESIS_THRESHOLD ?? 2);
  const episodes = store.episodes().filter(e =>
    e.signature === signature && (!agent_role || e.agent_role === agent_role));
  if (episodes.length < limit) return null;

  // Already have an active rule for this binding? Nothing to synthesise.
  const existing = store.lookup({ agent_role, signature });
  if (existing.length && !process.env.KB_RESYNTHESIZE) return existing[0];

  const cmd = runner || process.env.AI_RUNNER_CMD || path.join(SCRIPT_DIR, '..', 'ai-run.sh');
  const args = [];
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);

  const r = spawnSync('bash', [cmd, ...args], {
    input: buildPrompt({ agent_role, signature, episodes }),
    encoding: 'utf8',
    // Declared by the seam (invocation-profiles.json: kb-synthesizer), not carried here. This was
    // a literal, so the seam bounded its own LLM call with a number no run could see or change.
    timeout: _seamDeclared().timeoutMs,
    // B28: an explicit budget, not the inherited default. This is a reasoning
    // model emitting schema-bound JSON — <think> tokens are billed against the
    // same allowance, so an undersized budget yields truncated output that never
    // reaches the closing brace and is quarantined as 'unparseable'.
    env: {
      EPAM_AGENT_NAME: 'kb-synthesizer',
      ...process.env,
      EPAM_MAX_OUTPUT_TOKENS: _seamDeclared().maxOutputTokens,
      // Bind this step's own output space. It is the one place an LLM re-enters
      // the self-heal loop, so it should be the LAST place a reply has to be
      // salvaged by a parser. Only the enforcement/reason pair is required —
      // ids, scope and trigger are assigned here, not proposed by the model.
      EPAM_RESPONSE_SCHEMA: JSON.stringify({
        name: 'constraint_proposal',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['enforcement', 'reason'],
          properties: {
            enforcement: { type: 'object' },
            reason: { type: 'string' },
          },
        },
      }),
    },
  });
  const reply = (r.stdout || '').trim();
  const q = base => store.quarantine({ signature, agent_role, ...base });

  // PILLAR 4 — every path out of here that is NOT an admitted rule leaves
  // evidence. These were four bare `return null`s: a broken synthesizer looked
  // exactly like one with nothing to say.
  if (!reply) {
    // Distinguish a FAILED runner from a model that declined. `status` is null
    // when spawnSync could not run the command at all (ENOENT/timeout).
    q({ outcome: 'no_output',
        reason: r.status === 0 ? 'runner returned empty stdout' : `runner exit ${r.status ?? 'null'}`,
        detail: (r.stderr || '').slice(0, 400) || null });
    return null;
  }
  if (/^NO_CONSTRAINT\b/m.test(reply)) {
    q({ outcome: 'declined', reason: 'model declined: no enforceable constraint from these episodes' });
    return null;
  }

  const parsed = extractJson(reply);
  if (!parsed) {
    q({ outcome: 'unparseable', reason: 'reply contained no JSON object', raw: reply });
    return null;
  }
  if (!parsed.enforcement) {
    q({ outcome: 'unmapped_rule', reason: 'proposal has no enforcement mechanism',
        detail: 'advice-shaped output: exactly what the discriminated union exists to reject',
        raw: reply });
    return null;
  }

  const candidate = {
    id: store.slug(`${agent_role || 'global'}-${signature}`),
    scope: agent_role ? { agent_role } : { global: true },
    trigger: { signature },
    enforcement: parsed.enforcement,
    reason: String(parsed.reason || 'synthesised from repeated failures').slice(0, 300),
    origin_episodes: episodes.map(e => e.id).filter(Boolean),
  };

  try {
    // Hand the guard the limit the agent ACTUALLY hit, taken from the episodes'
    // own tool output. Without it the guard has no baseline: the env var it would
    // otherwise use is absent in production, and an exhaustion-triggered budget
    // rule then fails closed. The highest observed limit is the right baseline —
    // a fix must clear the worst case seen, not the mildest.
    // Math.max(NaN, x) is NaN, so seeding the reduce with NaN poisoned every
    // iteration and this was ALWAYS NaN regardless of the episodes. Filtering
    // finite values first does not help when the SEED is the problem — the guard
    // then fell through to fail-closed, which refused legitimate INCREASES too.
    const limits = episodes.map(e => Number(e.observed_limit)).filter(Number.isFinite);
    const observedLimit = limits.length ? Math.max(...limits) : undefined;

    // admit() validates FIRST, so an unenforceable proposal cannot archive an
    // existing rule as a side effect, and leaves the store untouched on refusal.
    return arb.admit(store, candidate, { observedLimit });
  } catch (e) {
    // Pydantic's field-level reason is the whole point — discarding it left
    // nobody able to tell WHY a rule was refused.
    q({ outcome: 'unmapped_rule',
        reason: 'refused by schema/arbitration',
        detail: String((e && e.message) || e).slice(0, 400),
        raw: reply });
    return null;
  }
}

function _seamDeclared() {
  const explicitT = Number(process.env.KB_SYNTHESIS_TIMEOUT_MS);
  const explicitO = process.env.KB_SYNTHESIS_MAX_OUTPUT_TOKENS;
  let secs; let out;
  try {
    const env = require("./seam-invocation.js").seamInvocationEnv("kb-synthesizer", undefined, { sourceEnv: process.env }) || {};
    secs = Number(env.EPAM_TIMEOUT_SECS);
    out = env.EPAM_MAX_OUTPUT_TOKENS;
  } catch (e) { /* undeclared: the caller sees undefined and fails with the reason */ }
  return {
    timeoutMs: (Number.isFinite(explicitT) && explicitT > 0) ? explicitT
      : ((Number.isFinite(secs) && secs > 0) ? secs * 1000 : undefined),
    maxOutputTokens: explicitO || out,
  };
}

module.exports = { maybeSynthesize, buildPrompt, extractJson, constraintSchema };
