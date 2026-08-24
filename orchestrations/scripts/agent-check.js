#!/usr/bin/env node
/**
 * PROVE ONE AGENT WORKS, ON ITS OWN, WITHOUT A PIPELINE RUN.
 *
 * Every agent defect found on 2026-08-23 was found by launching a run, watching it, and reading
 * what it left behind: the roster reviewer with no tools, the ladder that never reached a seam, the
 * brief block that rendered blank. Each cost a paid run to see, and killing the run destroyed the
 * evidence. That is the wrong way round — an agent is a unit and should be provable as one.
 *
 * This invokes ONE seam through the SAME path a run uses — its declared prompt, its declared
 * ladder and model, its declared tool grant, ai-run.sh — with a small, realistic input, and checks
 * the reply against what the seam declares it produces. No orchestration, no story loop, no reset,
 * no writes to a codeline.
 *
 * IT SPENDS REAL TOKENS, deliberately: the question is whether the agent works, and a mocked reply
 * answers a different question. One call per agent, smallest input that is still honest.
 *
 *   agent-check.js --seam <name>        check one
 *   agent-check.js --all                check every seam that declares a prompt
 *   agent-check.js --seam <name> --dry  render and validate the INPUT only; calls nothing
 *
 * Exit status is 0 only when every checked agent answered and its answer met its contract.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, 'lib');
const REGISTRY = path.join(__dirname, '..', 'agents', 'invocation-profiles.json');
const AI_RUN = path.join(__dirname, 'ai-run.sh');

const argv = process.argv.slice(2);
const arg = (f, d = '') => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

/** Every seam that names a prompt — read from the registry, never listed here. */
function seams() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const out = [];
  (function walk(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') {
        if (typeof v.template === 'string') {
          out.push({ seam: k, template: v.template, produces: v.produces || '', profile: v });
        }
        walk(v);
      }
    }
  }((reg.profiles || {})));
  return out;
}

/**
 * A REALISTIC VALUE FOR ONE PLACEHOLDER.
 *
 * Derived from the placeholder's own name rather than a per-seam table: a table of 39 seams'
 * inputs is a second description of the pipeline that drifts from the first. The names are the
 * pipeline's own vocabulary — __STORY_ID__, __DIFF__, __CODELINE_CONTEXT__ — and they say what the
 * value is. Where a name is not self-describing the value is still a plainly-labelled string, so a
 * reply that depends on it can be read as depending on it.
 */
function valueFor(ph, ctx) {
  const n = ph.replace(/^__|__$/g, '').toLowerCase();
  const pick = (...pairs) => {
    for (const [re, v] of pairs) if (re.test(n)) return v;
    return null;
  };
  return pick(
    [/story_?id|ticket_?id|jira/, ctx.storyId],
    [/(^|_)path$|_path$|file$/, ctx.repoPath],
    [/codeline/, `- ${ctx.codeline} at ${ctx.repoPath}`],
    [/stack/, 'TypeScript, Node.js 20, jest'],
    [/title|summary/, 'Live preview of draft content in the CMS'],
    [/description|body|context|block|section|prompt|note|addendum|persona/,
      'This is the supplied context for the check. It is short on purpose: the question is '
      + 'whether this agent answers in the shape it declares, not whether it can summarise a '
      + 'large input.'],
    [/diff|patch/, '--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-const a = 1;\n+const a = 2;\n'],
    [/test|spec/, 'src/x.test.ts'],
    [/criteria|ac(s)?$|vc(s)?$/, 'AC1: the page renders draft content when preview is enabled'],
    [/command|cmd/, 'npm test'],
    [/model|rung/, 'z-ai/glm-5.2'],
    [/tool/, 'read_file, list_files, search'],
    [/error|failure|log/, 'SyntaxError: Unexpected token export'],
    [/count|max|budget|limit/, '3'],
  ) || `(supplied value for ${ph})`;
}

/**
 * A REAL ARTEFACT, WHERE THE PIPELINE HAS ONE, BUILT BY THE PIPELINE'S OWN PRODUCER.
 *
 * Derived filler is fine for a placeholder that only has to be present. It is not fine for the
 * artefact a seam exists to JUDGE. roster-review was handed six copies of "this is the supplied
 * context for the check" where the roster should be, told to falsify the claims in it, and
 * returned nothing three times — which read as a broken agent and was a broken input.
 *
 * So the block comes from buildRosterBriefBlock — the same function the run calls — over the
 * project's own files. Nothing about any project is written here: the config directory is input,
 * the roles and briefs are read from it, and a project without them falls back to derived text.
 */
function realValueFor(ph, ctx) {
  const cfg = process.env.EPAM_PROJECT_CONFIG_DIR;
  if (!cfg) return null;
  const readJson = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(cfg, f), 'utf8')); } catch { return null; }
  };
  const n = ph.replace(/^__|__$/g, '').toLowerCase();

  // A PATH MUST POINT AT THE ARTEFACT, NOT AT THE REPO. __ROSTER_PATH__ and __CANONICAL_PATH__
  // were both resolved to the repository root by the generic `_path` rule, so roster-specialiser
  // and project-roster-review were handed a directory where a roster file was promised. Both read
  // it, found no roster, and returned nothing at all — three attempts, every rung, no output.
  const CANONICAL = path.join(__dirname, '..', 'agents', 'profiles.json');
  if (/canonical/.test(n) && /path/.test(n)) return CANONICAL;

  // A DESTINATION IS A SANDBOX COPY, NEVER THE LIVE FILE.
  //
  // roster-specialiser holds toolGrant "write" and its prompt says "the file you write". Pointing
  // __OUT_PATH__ at the project's own agent-profiles.json handed a write-granted agent the live
  // roster: on 2026-08-23 at 18:59 it overwrote the project's minted briefs with a specialised
  // copy of the canonical roster, destroying the run's mint output.
  //
  // A check must never be able to damage the thing it is checking. Anything an agent WRITES goes
  // to a scratch copy; anything it READS may be the real artefact.
  const sandbox = path.join(ctx.outDir, 'sandbox');
  if (/out_?path|dest|target_?path|write_?path/.test(n)) {
    fs.mkdirSync(sandbox, { recursive: true });
    const dest = path.join(sandbox, 'agent-profiles.json');
    const live = path.join(cfg, 'agent-profiles.json');
    try { if (fs.existsSync(live) && !fs.existsSync(dest)) fs.copyFileSync(live, dest); } catch { /* a fresh file is fine */ }
    return dest;
  }
  if (/roster_?path/.test(n)) {
    // THE DERIVED ROSTER IS ITS PRODUCER'S OUTPUT. project-roster-review judges the roster
    // roster-specialiser writes — a canonical-derived roster keyed `agents`. Pointing it at the
    // project's minted briefs instead gave it a file with no derived roster in it, and it
    // answered "nothing_to_review", which was true of what it was handed and told us nothing
    // about the seam. Prefer the real produced artefact; fall back to the project's own file.
    const produced = path.join(ctx.outDir, 'sandbox', 'agent-profiles.json');
    try {
      if (fs.existsSync(produced)) {
        const doc = JSON.parse(fs.readFileSync(produced, 'utf8'));
        if (doc && doc.agents && Object.keys(doc.agents).length) return produced;
      }
    } catch { /* fall through to the project's file */ }
    const f = path.join(cfg, 'agent-profiles.json');
    return fs.existsSync(f) ? f : null;
  }

  // ONE BATCH OF REAL PERSONA PAIRS, BUILT THE WAY THE RUNNER BUILDS THEM.
  //
  // project-roster-review is handed canonical/derived pairs rather than paths, because a whole
  // roster does not fit through tools. A check that fills that block with derived filler asks the
  // reviewer to judge nothing, and it correctly answers 'nothing_to_review' — which is what
  // happened on 2026-08-23, and it read as the seam failing rather than the input being empty.
  // One invocation is one batch, so one batch of real pairs is exactly the right payload.
  if (/pair/.test(n) && ctx.outDir) {
    try {
      const rosterFile = path.join(ctx.outDir, 'sandbox', 'agent-profiles.json');
      const canonFile = path.join(__dirname, '..', 'agents', 'profiles.json');
      const roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
      const canonRaw = JSON.parse(fs.readFileSync(canonFile, 'utf8'));
      const canon = (canonRaw.agents && typeof canonRaw.agents === 'object') ? canonRaw.agents : canonRaw;
      const personaOf = (v) => (typeof v === 'string' ? v : String((v && v.persona) || ''));
      const entries = roster.agents || {};
      const budget = Math.max(4000, Number(process.env.EPAM_ROSTER_REVIEW_BATCH_CHARS || '60000'));
      const out = [];
      let size = 0;
      for (const name of Object.keys(entries)) {
        const derived = personaOf(entries[name]);
        if (!derived.trim()) continue;
        const canonical = personaOf(canon[(entries[name] && entries[name].ancestor) || name]);
        const cost = derived.length + canonical.length + name.length + 200;
        if (out.length && size + cost > budget) break;
        out.push(`--- AGENT: ${name}\nCANONICAL:\n${canonical || '(no canonical ancestor text)'}\nDERIVED:\n${derived}`);
        size += cost;
      }
      if (out.length) return out.join('\n\n');
    } catch { /* no produced roster yet — fall through to derived text */ }
  }

  // THE PRODUCER'S REAL OUTPUT FEEDS ITS CONSUMER. The registry already states who produces what,
  // and this harness saves every reply. So a seam that judges a survey is given the survey the
  // survey agent actually wrote in this same session, not text invented from the placeholder name.
  if (/survey/.test(n) && ctx.outDir) {
    const produced = path.join(ctx.outDir, 'estate_survey.reply.txt');
    try {
      const t = fs.readFileSync(produced, 'utf8');
      if (t.trim()) return t;
    } catch { /* not captured yet — fall through to derived text */ }
  }

  // THE PROJECT'S OWN ROLES AND STORIES, read from files the pipeline itself reads. role-assigner
  // refused outright — "no roles are listed, only placeholder text" — because it was asked to
  // assign work from filler. It was right to refuse.
  if (/role/.test(n) && !/assign/.test(n)) {
    const roles = readJson('project-roles.json');
    const profiles = readJson('agent-profiles.json');
    const list = ((roles || {}).roles) || [];
    if (list.length) {
      const briefs = (profiles && profiles.profiles) || profiles || {};
      return list.map((r) => `- ${r}\n  ${String(briefs[r] || '(no brief)').split('\n')[0]}`).join('\n');
    }
  }
  if (/story|stories/.test(n)) {
    const prd = readJson('prd.json');
    const st = (prd || {}).stories || [];
    if (st.length) {
      return st.map((x) => `- ${x.id || x.jiraKey}: ${x.title}\n  codelines: ${ctx.codeline}`).join('\n');
    }
  }

  // THE MINTED ROSTER, built by the pipeline's own producer over the project's own files.
  if (!/brief|roster/.test(n)) return null;
  const roles = readJson('project-roles.json');
  const invs = readJson('project-investigators.json');
  const profiles = readJson('agent-profiles.json');
  if (!profiles) return null;
  const minted = [
    ...(((roles || {}).roles) || []).map((x) => ({ name: x, kind: 'implementer', codeline: ctx.codeline })),
    ...(((invs || {}).investigators) || []).map((x) => ({ name: x, kind: 'investigator', codeline: ctx.codeline })),
  ];
  if (!minted.length) return null;
  try {
    // eslint-disable-next-line global-require
    const spec = require(path.join(__dirname, 'spec-mode-runner.js'));
    if (typeof spec.buildRosterBriefBlock !== 'function') return null;
    const block = spec.buildRosterBriefBlock(minted, {}, profiles);
    return block && block.trim() ? block : null;
  } catch { return null; }
}

/** Render the prompt this seam actually executes, with every placeholder it declares supplied. */
function renderFor(s, ctx) {
  // eslint-disable-next-line global-require
  const { renderEngineTemplate, placeholdersIn } = require(path.join(LIB, 'engine-prompt.js'));
  const tplPath = path.join(__dirname, '..', 'prompts', 'templates', `${s.template}.json`);
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  // EVERY PART, NOT THE FIRST. A multi-body prompt declares the UNION of its parts' placeholders,
  // so rendering only part one and supplying only its placeholders fails on a value another part
  // needs — which reads as a pipeline defect and is not one. tc-writer found this immediately.
  const parts = tpl.bodies ? Object.keys(tpl.bodies) : [null];
  const rendered = [];
  for (const part of parts) {
    const body = part ? tpl.bodies[part] : String(tpl.body || '');
    const values = {};
    for (const ph of [...new Set(placeholdersIn(body))]) values[ph] = realValueFor(ph, ctx) || valueFor(ph, ctx);
    // The declared set may exceed this part's own usage; supply those too so the render is total.
    for (const ph of (tpl.placeholders || [])) if (!(ph in values)) values[ph] = realValueFor(ph, ctx) || valueFor(ph, ctx);

    // AND THE PROJECT COPY MAY DECLARE MORE THAN THE TEMPLATE. It is generated, so it can carry a
    // placeholder the template does not — tc-writer's does. Rather than guess at the difference,
    // the renderer is asked, and it names exactly what it is missing. Bounded, so a renderer that
    // always refuses cannot spin here.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rendered.push(renderEngineTemplate(s.template, values, part || undefined));
        break;
      } catch (e) {
        const m = String(e.message).match(/missing values for:\s*(.+)$/m);
        if (!m) throw e;
        const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
        if (!names.length) throw e;
        for (const ph of names) values[ph] = realValueFor(ph, ctx) || valueFor(ph, ctx);
        if (attempt === 5) throw e;
      }
    }
  }
  return rendered.join('\n\n');
}

/**
 * Did the agent answer in the shape its seam declares?
 *
 * Deliberately shallow: this asks whether the reply is USABLE — non-empty, and parseable as the
 * kind of thing the seam produces. Whether the content is correct is the agent's job and a
 * reviewer's; whether it is receivable at all is what every failure this month turned on.
 */
/**
 * THE LARGEST JSON DOCUMENT IN A REPLY, FOUND BY BALANCING BRACKETS.
 *
 * A greedy `/\{[\s\S]*\}|\[[\s\S]*\]/` spans from the first opening bracket to the last closing
 * one, so any bracket in the surrounding prose swallows the real document. agent-mint returned a
 * valid roster and was failed with "Unexpected token '.', \"[[...slug]]\"" — the match had started
 * at a Next.js catch-all route written in a sentence.
 *
 * This scans every candidate start, tracks depth with string and escape awareness, and returns the
 * largest span that actually parses. A fenced ```json block wins outright when present.
 */
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([[{][\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through to scanning */ }
  }
  let best = null;
  let bestLen = 0;
  for (let i = 0; i < text.length; i += 1) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = i; k < text.length; k += 1) {
      const c = text[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          const span = text.slice(i, k + 1);
          if (span.length > bestLen) {
            try { const v = JSON.parse(span); best = v; bestLen = span.length; } catch { /* not it */ }
          }
          break;
        }
      }
    }
  }
  return best;
}

function checkReply(raw, produces, profile) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, why: 'the agent returned nothing' };
  // THE SEAM SAYS WHAT SHAPE IT ANSWERS IN, not this file's guess at it. prompt-builder declares
  // `_outputIsArtefact` — "its output IS the minted prompt layer on disk" — so a prompt in plain
  // text is exactly right, and demanding JSON of it reported a working agent as broken.
  if (profile && profile._outputIsArtefact) {
    return { ok: true, why: `${text.length} chars (artefact, not JSON by declaration)` };
  }
  const looksJson = /^[[{]/.test(text) || /\{[\s\S]*\}/.test(text);
  if (/verdict|report|assignments|selection|criteria|survey|roster|prompts|contracts|estimate|findings|evidence|specification|summary|diagnosis|plan/i.test(produces)) {
    if (!looksJson) {
      return { ok: false, why: `declares it produces '${produces}' but the reply carries no JSON` };
    }
    const found = extractJson(text);
    if (!found) {
      return { ok: false, why: 'the reply carries no parseable JSON document' };
    }
  }
  return { ok: true, why: `${text.length} chars` };
}

// THE SEAM'S OWN TIMEOUT, as a decision that can be asserted without spending a token.
// roster-review declares timeoutSecs: 900; the harness cut it off at 300 and reported the agent
// as failing. The registry states each seam's budget. An explicit --timeout-ms still overrides,
// because an operator narrowing the budget on purpose is a different thing from a default.
function budgetFor(profile, ctx) {
  const fallback = Number(ctx.timeoutMs) || 300000;
  if (ctx.timeoutMsExplicit) return fallback;
  const declaredMs = Number(profile && profile.timeoutSecs) * 1000;
  return Number.isFinite(declaredMs) && declaredMs > 0 ? declaredMs : fallback;
}

/**
 * THE STRUCTURED-OUTPUT CONTRACT THE SEAM REALLY RUNS WITH.
 *
 * Several seams do not ask for JSON in their prompt text at all — the shape is bound at the
 * invocation, as EPAM_RESPONSE_SCHEMA built from a tool definition, and the CLI turns that into a
 * strict response schema. A check that omits it is not running the seam the pipeline runs: on
 * 2026-08-23 role-assigner returned its (correct) answer as a markdown table and survey-review as
 * prose, and both were recorded as failures for not producing JSON nobody had asked them for.
 *
 * The binding is discovered, never listed here: the runner exports its tool definitions, and a
 * seam is matched to one by comparing what the seam declares it `produces` with the tool's own
 * name (submit_role_assignments -> role-assignments).
 */
function responseSchemaFor(profile, seamName) {
  let defs;
  let src;
  try {
    // eslint-disable-next-line global-require
    defs = require(path.join(__dirname, 'spec-mode-runner.js'));
    src = fs.readFileSync(path.join(__dirname, 'spec-mode-runner.js'), 'utf8');
  } catch { return null; }

  // THE BINDING IS READ FROM THE CALL SITE THAT MAKES IT. Matching a tool by name against what a
  // seam `produces` looked reasonable and was wrong: survey-verdict is submitted by
  // submit_survey_review, roster-verdict by submit_roster_review. Guessing the association is the
  // same mistake as guessing the timeout or the output shape, so it is discovered instead — the
  // runner builds env with seamInvocationEnv('<seam>') and schemaEnv(TOOL_X) in one expression.
  const re = new RegExp(`seamInvocationEnv\\(\\s*['"\`]${seamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`, 'g');
  let m;
  while ((m = re.exec(src))) {
    // BOTH FORMS COUNT. Most seams bind through `EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_X)` in the
    // env literal; survey-review passes TOOL_SURVEY_REVIEW straight to the call helper twenty
    // lines further down. Only definitions that are real tool defs are accepted, so unrelated
    // TOOL_ constants (TOOL_CALLS, TOOL_TIMEOUT_MS) cannot be mistaken for one.
    const window = src.slice(m.index, m.index + 2000);
    const names = [];
    const viaEnv = window.match(/schemaEnv\((TOOL_[A-Z_]+)\)/);
    if (viaEnv) names.push(viaEnv[1]);
    for (const tok of window.match(/\bTOOL_[A-Z_]+\b/g) || []) if (!names.includes(tok)) names.push(tok);
    for (const n of names) {
      const def = defs[n];
      if (def && def.name && def.parameters) {
        try { return JSON.stringify({ name: def.name, schema: def.parameters }); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * THE SEAM'S OWN CONTRACT, NOT JUST ITS ABILITY TO ANSWER.
 *
 * A seam answering in shape is not a seam doing its job, and the pipeline already knows the
 * difference — it just knows it in the contract loop this harness was invoking around. Two seams
 * reported green on 2026-08-23 while producing work the real run would have refused:
 *
 *   roster-specialiser     wrote 38 of the 57 canonical agents. checkRoster() refuses an
 *                          incomplete roster ("whatever canonical holds, the roster holds") and
 *                          re-prompts with the gap. Called raw, nothing checked it.
 *   project-roster-review  answered 'nothing_to_review'. spec-mode-runner maps that to
 *                          review_failed — the judge did not look — and retries the judge. Called
 *                          raw, "it returned valid JSON" was the whole of the verdict.
 *
 * So the contract is applied here too, from the same libraries the run uses. Nothing is
 * reimplemented: an incomplete roster fails because checkRoster says so.
 */
function contractVerdict(seam, raw, ctx) {
  // The roster a producer wrote must satisfy the roster contract.
  if (/roster-specialiser|roster-specialis/.test(seam)) {
    try {
      // eslint-disable-next-line global-require
      const { checkRoster } = require(path.join(LIB, 'project-roster.js'));
      const out = path.join(ctx.outDir, 'sandbox', 'agent-profiles.json');
      if (!fs.existsSync(out)) return { ok: false, why: 'it wrote no roster at the destination it was given' };
      const roster = JSON.parse(fs.readFileSync(out, 'utf8'));
      const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents', 'profiles.json'), 'utf8'));
      const flat = canonical.agents && typeof canonical.agents === 'object' ? canonical.agents : canonical;
      const personas = {};
      for (const n of Object.keys(flat)) {
        const v = flat[n];
        personas[n] = typeof v === 'string' ? v : String((v && v.persona) || '');
      }
      const v = checkRoster(roster, personas);
      if (!v.ok) {
        const n = (v.bad || []).length;
        return { ok: false, why: `its roster fails the roster contract (${n} problem(s)): ${String(v.reason).slice(0, 160)}` };
      }
      return { ok: true, why: `${Object.keys(roster.agents || {}).length} agents, contract satisfied` };
    } catch (e) { return { ok: false, why: `its roster could not be checked: ${e.message.slice(0, 90)}` }; }
  }

  // A REVIEW THAT DID NOT LOOK IS NOT A PASS. The runner's own translation decides this.
  if (/roster-review|project-roster-review|survey-review|prompt-review/.test(seam)) {
    const doc = extractJson(String(raw || ''));
    const verdict = doc && (doc.verdict || doc.status);
    if (verdict === 'nothing_to_review' || (doc && !doc.verdict && !Array.isArray(doc.findings))) {
      return { ok: false, why: `it did not examine anything — returned '${verdict || 'no verdict'}'` };
    }
    // A condemnation that names nothing is not a review either — the runner refuses it for the
    // same reason, so a check that accepted it would report green on work the run would reject.
    if (verdict === 'defects_found' && Array.isArray(doc.findings) && !doc.findings.length) {
      return { ok: false, why: 'it answered defects_found but listed no findings — nothing was contradicted' };
    }
  }
  return null;
}

function checkOne(s, ctx) {
  let prompt;
  try {
    prompt = renderFor(s, ctx);
  } catch (e) {
    return { seam: s.seam, stage: 'input', ok: false, why: `prompt did not render: ${e.message}` };
  }
  if (!prompt.trim()) return { seam: s.seam, stage: 'input', ok: false, why: 'rendered empty' };
  if (ctx.dry) return { seam: s.seam, stage: 'input', ok: true, why: `${prompt.length} chars` };

  // THE SAME INVOCATION PATH A RUN USES: the seam's own env — its ladder, model, effort, tool
  // grant — resolved through seam-invocation, then ai-run.sh. A check that called a model directly
  // would prove the model works, not that this seam does.
  let env = { ...process.env, EPAM_AGENT_NAME: s.seam };
  try {
    // eslint-disable-next-line global-require
    const { seamInvocationEnv } = require(path.join(LIB, 'seam-invocation.js'));
    env = { ...env, ...seamInvocationEnv(s.seam, undefined, { env }) };
  } catch { /* a seam with no resolvable env still gets checked, and will say so */ }

  // Bind the seam's declared output shape, exactly as the runner does.
  const schema = responseSchemaFor(s.profile, s.seam);
  if (schema) env.EPAM_RESPONSE_SCHEMA = schema;

  const tmp = path.join(require('os').tmpdir(), `agent-check-${s.seam.replace(/\W/g, '_')}.txt`);
  fs.writeFileSync(tmp, prompt);
  const keep = (suffix, text) => {
    try {
      fs.mkdirSync(ctx.outDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.outDir, `${s.seam.replace(/\W/g, '_')}.${suffix}`), String(text || ''));
    } catch { /* keeping evidence must never fail the check */ }
  };
  // BEFORE THE CALL. Saving after it returns means a timeout — the one failure that costs the most
  // to reproduce — leaves nothing behind. roster-review timed out and left no prompt to read.
  keep('prompt.txt', prompt);

  // THE SEAM'S OWN TIMEOUT. roster-review declares timeoutSecs: 900 and the harness cut it off at
  // 300, then reported the agent as failing. The registry states each seam's budget; a check that
  // substitutes its own is measuring the harness. An explicit --timeout-ms still overrides.
  const budgetMs = budgetFor(s.profile, ctx);
  try {
    const raw = execFileSync('bash', [AI_RUN], {
      encoding: 'utf8', env, timeout: budgetMs, input: fs.readFileSync(tmp, 'utf8'),
      maxBuffer: 10 * 1024 * 1024,
      // THE CODELINE IS THE WORKING DIRECTORY, exactly as spec-mode-runner spawns it.
      //
      // read_file/list_files/search resolve relative paths against the CLI process's own cwd and
      // never consult PROJECT_ROOT; the runner compensates with `cwd: env.PROJECT_ROOT` on its
      // spawn (verified live 2026-08-06). This call had no cwd, so it inherited the orchestrator's
      // — epam-cli itself. estate-survey then surveyed THIS repository while reporting on the
      // target codeline, describing "30+ commander subcommands" as the codeline under test, and
      // survey-review caught it: "the list_files results appear to be coming from the wrong
      // project". A check that runs an agent against the wrong repository proves nothing.
      cwd: env.PROJECT_ROOT || process.cwd(),
    });
    // EVERY REPLY IS KEPT. A failure I cannot read is a failure I have to pay to reproduce —
    // which is the whole reason this harness exists.
    keep('reply.txt', raw);
    const v = checkReply(raw, s.produces, s.profile);
    if (!v.ok) return { seam: s.seam, stage: 'reply', ...v };
    // Answered in shape — now hold it to the contract the run would hold it to.
    const c = contractVerdict(s.seam, raw, ctx);
    if (c) return { seam: s.seam, stage: 'contract', ...c };
    return { seam: s.seam, stage: 'reply', ...v };
  } catch (e) {
    keep('error.txt', `${e.message}\n\n--- stdout ---\n${e.stdout || ''}\n\n--- stderr ---\n${e.stderr || ''}`);
    const timedOut = /ETIMEDOUT/.test(String(e.message));
    const why = timedOut
      ? `timed out after ${Math.round(budgetMs / 1000)}s (seam declares ${s.profile && s.profile.timeoutSecs || '?'}s)`
      : `the call failed: ${String(e.message).slice(0, 110)}`;
    return { seam: s.seam, stage: 'call', ok: false, why };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

module.exports = { budgetFor, checkReply, extractJson, responseSchemaFor, contractVerdict };

// RUNNING IS OPT-IN. Requiring this file used to execute the whole batch — which meant the two
// decisions it gets wrong could not be unit-tested at all, and a test that imported it called
// process.exit(2) on collection.
if (require.main !== module) return;

const ctx = {
  storyId: arg('--story', 'AMSD-2041'),
  codeline: arg('--codeline', 'metrolinx'),
  repoPath: arg('--repo', process.env.PROJECT_ROOT || process.cwd()),
  dry: has('--dry'),
  timeoutMs: arg('--timeout-ms', '300000'),
  timeoutMsExplicit: process.argv.includes('--timeout-ms'),
  outDir: arg('--out-dir', path.join(require('os').tmpdir(), 'agent-check')),
};

// WHICH BATCH. Derived from where a seam sits relative to the two pause points, because a run is
// approved in those units: everything up to the mint, everything up to the writer, and the writer
// and its judges. The post-pause-2 set is the writer, its reviewers, the analysts that heal a
// failed attempt, the repro writer and every QA gate.
const POST_PAUSE_2 = new Set(['story-writer', 'team-lead-review', 'code-review-cycle',
  'repro-test-writer', 'agent-failure-analyst', 'impl-failure-analyst']);
const PRE_PAUSE_1 = new Set(['codeline-discovery', 'ac-classification', 'ac-elaboration',
  'estate-survey', 'survey-review', 'prompt-builder', 'prompt-review', 'agent-mint',
  'roster-review', 'roster-specialiser', 'project-roster-review', 'role-assigner']);
const isPost = (n) => POST_PAUSE_2.has(n) || n.startsWith('qa-gate:');

const all = seams();
let wanted = has('--all') ? all : all.filter((s) => s.seam === arg('--seam'));
if (has('--pre-pause-1')) wanted = all.filter((s) => PRE_PAUSE_1.has(s.seam));
if (has('--pre-pause-2')) wanted = all.filter((s) => !isPost(s.seam) && !PRE_PAUSE_1.has(s.seam));
if (has('--through-pause-2')) wanted = all.filter((s) => !isPost(s.seam));
if (!wanted.length) {
  process.stderr.write(`no seam matched. --all, or --seam <one of>:\n  ${all.map((s) => s.seam).join('\n  ')}\n`);
  process.exit(2);
}

const results = [];
for (const s of wanted) {
  const r = checkOne(s, ctx);
  results.push(r);
  process.stdout.write(`${(r.ok ? 'ok  ' : 'FAIL')}  ${r.seam.padEnd(26)} ${r.stage.padEnd(6)} ${r.why}\n`);
}
const bad = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - bad.length}/${results.length} agent(s) answered in contract\n`);
process.exit(bad.length ? 1 : 0);
