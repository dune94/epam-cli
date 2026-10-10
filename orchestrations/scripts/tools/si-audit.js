#!/usr/bin/env node
/**
 * si-audit.js — does an agent's standing instructions (SI) agree with what the pipeline gives it?
 *
 *   node orchestrations/scripts/tools/si-audit.js --seam team-lead-review --si <file>
 *        [--project <name>] [--facts-only] [--out <dir>]
 *
 * Operator, 2026-09-29: "there are gaps in the SI and if there are gaps there are gaps in the
 * pipeline. Each SI must work for both greenfield and brownfield." A DESIGN-TIME tool: nothing in
 * a run calls it, it gates nothing, and it changes no agent.
 *
 * LAYER 1 — THE FACT SHEET, from the pipeline's own declarations and nothing else: the seam's
 * registry entry, which seams (or the engine) produce each input it consumes and in which project
 * kinds, its tool grant as lib/agent-tools.js resolves it, its output contract, and the values its
 * template's answer shape allows. Then the checks that are exact, not judged:
 *   - tool:     the SI names a pipeline tool its grant does not hold
 *   - outcome:  the SI speaks of an answer key (e.g. verdict) and names none of the values the
 *               template allows for it, or names only some of them
 *   - kind:     the seam runs in more than one project kind and the SI names only one of them
 *
 * LAYER 2 — ONE REVIEW BY A MODEL, through llm-handler.sh (the pipeline's only LLM hub), with the
 * model the provider set's ladder puts at the TOP position. It is given the fact sheet, the
 * template and the SI, and returns findings per project kind. A finding whose `fact` is not a
 * verbatim line of the fact sheet or template is DISCARDED and counted — the same rule the
 * pipeline applies to an unevidenced review finding (lib/handlers/code-review-json.py).
 *
 * Exit: 0 no findings, 1 findings, 2 tool error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.resolve(__dirname, '..', '..', '..');
const ORCH = path.join(ENGINE, 'orchestrations');
const SCRIPTS = path.join(ORCH, 'scripts');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}

/** The project kinds, from the engine's own reader of a project's config — never spelled here. */
function projectKinds() {
  const { projectModes } = require(path.join(SCRIPTS, 'lib', 'seams-expected.js'));
  return [...new Set([...projectModes(''), ...projectModes('EPAM_BROWNFIELD=1')])];
}

/** In which project kinds a seam runs: always, only when an extra mode holds, or never. */
function runsIn(profile, kind, kinds) {
  const a = Array.isArray(profile && profile.appliesTo) ? profile.appliesTo : null;
  if (!a) return 'always';
  if (a.includes(kind)) return 'always';
  const extra = a.filter((m) => !kinds.includes(m));
  return extra.length ? `when ${extra.join('/')}` : 'never';
}

/** Every `"key":"a|b"` / `"key":"a"` pair in the template's answer shape, minus placeholders. */
function answerValues(body) {
  const out = {};
  for (const m of String(body).matchAll(/\\?"([A-Za-z_]+)\\?"\s*:\s*\\?"([^"\\]*)\\?"/g)) {
    const vals = m[2].split('|').map((v) => v.trim()).filter((v) => /^[A-Za-z_]+$/.test(v));
    if (!vals.length) continue;
    out[m[1]] = [...new Set([...(out[m[1]] || []), ...vals])];
  }
  return out;
}

function factSheet(seam) {
  const reg = readJson(path.join(ORCH, 'agents', 'invocation-profiles.json'));
  const profiles = reg.profiles || {};
  const p = profiles[seam];
  if (!p) throw new Error(`no seam '${seam}' in the registry`);
  const kinds = projectKinds();
  const engine = new Set(reg.engineProduces || []);
  const tools = require(path.join(SCRIPTS, 'lib', 'agent-tools.js'));
  const grant = p.toolGrant || '';
  const grantTools = grant ? tools.toolGrantFor(grant, []).split(',').filter(Boolean) : [];
  const allTools = tools.toolGrantFor('write', []).split(',').filter(Boolean);
  for (const g of Object.keys((readJson(path.join(ORCH, 'config', 'spec-mode-defaults.json')).tools.grants) || {})) {
    for (const t of tools.toolGrantFor(g, []).split(',').filter(Boolean)) if (!allTools.includes(t)) allTools.push(t);
  }
  const contracts = readJson(path.join(ORCH, 'config', 'seam-output-contracts.json'));
  const contract = (contracts.seams || contracts)[seam] || null;
  const tplFile = p.template ? path.join(ORCH, 'prompts', 'templates', `${p.template}.json`) : '';
  const template = tplFile && fs.existsSync(tplFile) ? readJson(tplFile) : null;

  const inputs = (p.consumes || []).map((c) => {
    const producers = Object.entries(profiles)
      .filter(([, q]) => q && q.produces === c.kind)
      .map(([name, q]) => ({ seam: name, runs: Object.fromEntries(kinds.map((k) => [k, runsIn(q, k, kinds)])) }));
    const byKind = Object.fromEntries(kinds.map((k) => {
      if (engine.has(c.kind)) return [k, 'always (engine)'];
      const r = producers.map((x) => x.runs[k]);
      return [k, r.includes('always') ? 'always' : (r.find((x) => x.startsWith('when')) || 'never')];
    }));
    return { kind: c.kind, required: !!c.required, producers: producers.map((x) => x.seam), engine: engine.has(c.kind), byKind };
  });

  return {
    seam, what: p._what || '', kinds,
    runs: Object.fromEntries(kinds.map((k) => [k, runsIn(p, k, kinds)])),
    grant, grantTools, allTools, contract,
    template: template ? { id: template.id, body: template.body || '', placeholders: template.placeholders || [], mayBeEmpty: template.mayBeEmpty || [] } : null,
    answer: template ? answerValues(template.body) : {},
    inputs,
  };
}

/** The fact sheet as numbered lines: what Layer 2 must quote, and what an operator reads. */
function factLines(f) {
  const L = [];
  L.push(`SEAM ${f.seam}: ${f.what}`);
  for (const k of f.kinds) L.push(`RUNS IN ${k}: ${f.runs[k]}`);
  L.push(`TOOL GRANT ${f.grant || '(none)'}: ${f.grantTools.join(', ') || 'no tools'} (plus the SAFE tools the project's codeline plugins provide)`);
  const denied = f.allTools.filter((t) => !f.grantTools.includes(t));
  if (denied.length) L.push(`TOOLS NOT GRANTED: ${denied.join(', ')}`);
  if (f.contract) L.push(`OUTPUT CONTRACT: required keys ${JSON.stringify(f.contract.requiredKeys || [])}, known keys ${JSON.stringify(f.contract.knownKeys || [])}`);
  for (const [k, v] of Object.entries(f.answer)) L.push(`ANSWER VALUES ${k}: ${v.join(' | ')}`);
  if (f.template) {
    for (const ph of f.template.placeholders) {
      L.push(`TEMPLATE FILLS ${ph}: ${f.template.mayBeEmpty.includes(ph) ? 'may render empty' : 'always rendered'}`);
    }
  }
  for (const i of f.inputs) {
    const src = [i.engine ? 'the engine' : '', ...i.producers].filter(Boolean).join(', ') || 'NO PRODUCER';
    L.push(`INPUT ${i.kind}${i.required ? ' (required)' : ''} from ${src}: ${f.kinds.map((k) => `${k} ${i.byKind[k]}`).join('; ')}`);
  }
  return L;
}

const words = (s) => String(s).toLowerCase();

function exactChecks(f, si) {
  const out = [];
  const text = words(si);
  for (const t of f.allTools) {
    if (!f.grantTools.includes(t) && new RegExp(`\\b${t}\\b`).test(si)) {
      out.push({ check: 'tool', fact: `TOOLS NOT GRANTED: ${f.allTools.filter((x) => !f.grantTools.includes(x)).join(', ')}`, detail: `the SI names ${t}` });
    }
  }
  for (const [key, vals] of Object.entries(f.answer)) {
    if (vals.length < 2) continue;                       // a single value is an example, not a choice
    if (!new RegExp(`\\b${key}\\b`, 'i').test(si)) continue;
    const named = vals.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(si));
    if (named.length < vals.length) {
      out.push({ check: 'outcome', fact: `ANSWER VALUES ${key}: ${vals.join(' | ')}`,
        detail: named.length ? `the SI speaks of ${key} and names only ${named.join(', ')}` : `the SI speaks of ${key} and names none of its values` });
    }
  }
  const runningKinds = f.kinds.filter((k) => f.runs[k] !== 'never');
  if (runningKinds.length > 1) {
    const named = runningKinds.filter((k) => text.includes(k));
    if (named.length === 1) {
      out.push({ check: 'kind', fact: runningKinds.map((k) => `RUNS IN ${k}: ${f.runs[k]}`).join(' / '),
        detail: `the SI names only ${named[0]}; the seam also runs in ${runningKinds.filter((k) => k !== named[0]).join(', ')}` });
    }
  }
  return out;
}

/** The environment a pipeline call runs in, built the way claude.sh builds it. */
function hubEnv(projectDir) {
  const sh = [
    'set -e',
    `export AUTOMATION_DIR='${ORCH}'`,
    `export EPAM_PROJECT_CONFIG_DIR='${projectDir}'`,
    `. '${SCRIPTS}/lib/env-file.sh'; load_project_env '${projectDir}' preserve >/dev/null 2>&1 || true`,
    `. '${SCRIPTS}/lib/project-config.sh'; . '${SCRIPTS}/lib/model-ladders.sh'`,
    `export_model_ladders "$(project_settings_file '${projectDir}')" >/dev/null`,
    `. '${SCRIPTS}/lib/model-ladder.sh'; load_llm_settings_json >/dev/null 2>&1`,
    'command -p env -0',
  ].join('\n');
  const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: process.env, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`could not build the run environment: ${r.stderr}`);
  const env = {};
  for (const kv of r.stdout.split('\0')) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  return env;
}

function topModel(env) {
  const si = require(path.join(SCRIPTS, 'lib', 'seam-invocation.js'));
  const reg = readJson(path.join(ORCH, 'agents', 'invocation-profiles.json'));
  const positions = (reg._ladderPositions && reg._ladderPositions.names) || [];
  const top = positions[positions.length - 1];
  const tier = si.resolveTierPosition(top, env);
  if (!tier) throw new Error(`the ladder resolves no tier for position '${top}' — nothing to run the review on`);
  const start = env[`EPAM_MODEL_LADDER_${tier.toUpperCase().replace(/-/g, '_')}_START`];
  if (!start) throw new Error(`tier '${tier}' declares no start model`);
  return { tier, model: start };
}

function modelReview(f, si, projectDir, outDir) {
  const promptDef = readJson(path.join(__dirname, 'si-audit-prompt.json'));
  const lines = factLines(f);
  const prompt = promptDef.body
    .replace('__FACTS__', () => lines.join('\n'))
    .replace('__TEMPLATE__', () => f.template ? f.template.body : '(this seam has no template)')
    .replace('__SI__', () => si);
  const env = { ...hubEnv(projectDir) };
  const { tier, model } = topModel(env);
  Object.assign(env, { EPAM_MODEL: model, EPAM_AGENT_NAME: 'si-audit', EPAM_ALLOWED_TOOLS: '' });
  fs.writeFileSync(path.join(outDir, 'prompt.txt'), prompt);
  const r = spawnSync('bash', [path.join(SCRIPTS, 'llm-handler.sh'), '--model', model], {
    input: prompt, encoding: 'utf8', env, maxBuffer: 64 << 20, cwd: ENGINE,
  });
  fs.writeFileSync(path.join(outDir, 'reply.txt'), r.stdout || '');
  fs.writeFileSync(path.join(outDir, 'stderr.txt'), r.stderr || '');
  if (r.status !== 0) throw new Error(`llm-handler exited ${r.status} — see ${outDir}/stderr.txt`);
  const m = String(r.stdout).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in the review reply — see ${outDir}/reply.txt`);
  const reply = JSON.parse(m[0]);
  const sources = [...lines, ...String(f.template ? f.template.body : '').split('\n')].map((s) => s.trim());
  const grounded = (fact) => typeof fact === 'string' && fact.trim().length > 8
    && sources.some((s) => s.includes(fact.trim()));
  const kept = []; const dropped = [];
  for (const x of (Array.isArray(reply.findings) ? reply.findings : [])) (grounded(x.fact) ? kept : dropped).push(x);
  return { tier, model, findings: kept, discarded: dropped, summary: reply.summary || '' };
}

module.exports = { factSheet, factLines, exactChecks, answerValues, projectKinds, hubEnv, topModel };

if (require.main === module) {
  try {
    const seam = arg('seam');
    const siFile = arg('si');
    if (!seam || !siFile) { process.stderr.write('usage: si-audit.js --seam <seam> --si <file> [--project <name>] [--facts-only] [--out <dir>]\n'); process.exit(2); }
    const si = fs.readFileSync(siFile, 'utf8');
    const f = factSheet(seam);
    const report = { seam, facts: factLines(f), exact: exactChecks(f, si) };
    if (!process.argv.includes('--facts-only')) {
      const project = arg('project');
      if (!project) throw new Error('--project names whose provider set and ladder the review runs on');
      const out = path.resolve(arg('out', fs.mkdtempSync(path.join(require('os').tmpdir(), 'si-audit-'))));
      fs.mkdirSync(out, { recursive: true });
      report.review = modelReview(f, si, path.join(ORCH, 'projects', project), out);
      report.out = out;
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    const n = report.exact.length + (report.review ? report.review.findings.length : 0);
    process.exit(n ? 1 : 0);
  } catch (e) {
    process.stderr.write(`[si-audit] ${e.message}\n`);
    process.exit(2);
  }
}
