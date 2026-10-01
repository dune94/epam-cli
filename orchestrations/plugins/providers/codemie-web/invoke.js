'use strict';
/**
 * ONE PIPELINE CALL AS A CODEMIE WEB ASSISTANT — the codemie-web stack's runner.
 *
 *   node invoke.js --prompt-file F --model M --agent A --codeline C --result R.json
 *                  [--grant "read_file,search,…"] [--root DIR] [--read-root DIR] [--schema S.json]
 *
 * Called by the codemie-web provider plugin's runner.sh (provider_call), which the seam hub and the
 * story writer both reach through lib/provider-plugin.sh — one place a codemie-web call is built.
 *
 *   grant   the seam's tool grant (EPAM_ALLOWED_TOOLS): the plugin that serves it is read from the
 *           runner's `plugins` declaration; no grant is the full set, as on the claude runner.
 *   root    the codeline a writing plugin is rooted at; --read-root, the estate a reading one is.
 *   model   the ladder's rung, sent as the chat's llm_model — one assistant serves every rung.
 *   schema  a JSON schema the answer must follow (sent as output_schema).
 *
 * stdout: the answer. Exit 0 when the call answered, 1 when it did not (the reason on stderr, the
 * class in the result JSON).
 */
const fs = require('fs');
const path = require('path');
const { client } = require('./client.js');
const { ensureAssistant } = require('./registry.js');
const { ensurePlugin } = require('./plugins.js');
const { judge } = require('./result.js');

const RESOLVE = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'llm-settings-resolve.js');

/** This runner's declaration (the active set's runners entry): its tool vocabulary and its plugins. */
function declaration(env = process.env) {
  const { readSetFile, activeSetFile } = require(RESOLVE);
  const file = activeSetFile();
  const runners = (file && (readSetFile(file) || {}).runners) || {};
  const own = Object.values(runners).find((r) => r && Array.isArray(r.plugins)) || {};
  // THE PIPELINE'S OWN TOOLS, named by their modules: every hosted ToolPlugin's tools join the
  // runner's vocabulary, provided by every plugin — except that a readOnly plugin provides only the
  // tools whose own `permission` is 'safe'. Nothing about a tool is written in the declaration.
  const hostedToolPlugins = (own.hostedToolPlugins || []).map((m) => path.join(__dirname, '..', '..', '..', m));
  const toolNames = { ...(own.toolNames || {}) };
  const plugins = (own.plugins || []).map((p) => ({ ...p, provides: [...(p.provides || [])] }));
  for (const m of hostedToolPlugins) {
    for (const t of (require(m).tools || [])) {
      toolNames[t.name] = toolNames[t.name] || [t.name];
      for (const p of plugins) if (!p.readOnly || t.permission === 'safe') p.provides.push(t.name);
    }
  }
  return { toolNames, plugins, hostedToolPlugins };
}

/**
 * Which plugin serves a grant, read from the declaration: the first whose `provides` covers every
 * granted tool this runner declares; no grant is the full set (the last), as on the claude runner.
 * Granted tools this runner does not declare are returned as `dropped`, to be said aloud.
 */
function modeFor(grant, decl = declaration()) {
  const asked = String(grant || '').split(/[\s,]+/).filter(Boolean);
  const known = asked.filter((t) => Object.prototype.hasOwnProperty.call(decl.toolNames, t));
  const dropped = asked.filter((t) => !known.includes(t));
  const plugins = decl.plugins;
  if (!plugins.length) return { mode: null, dropped };
  if (!asked.length) return { mode: plugins[plugins.length - 1].mode, dropped };
  if (!known.length) return { mode: null, dropped };
  const fit = plugins.find((p) => known.every((t) => (p.provides || []).includes(t))) || plugins[plugins.length - 1];
  return { mode: fit.mode, dropped };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function invoke(a, env = process.env) {
  const prompt = fs.readFileSync(a['prompt-file'], 'utf8');
  const c = await client(env);
  // A TOOL BUDGET OF 0 IS NO TOOLS. The hub's plan pass declares itself tool-free this way
  // (EPAM_MAX_TOOL_CALLS=0, an empty grant); under "no grant is the full set" it was handed the
  // development plugin and a stand-in wrote from the plan pass (found 2026-09-29).
  const toolFree = a['max-tool-calls'] !== undefined && Number(a['max-tool-calls']) === 0;
  const { mode, dropped } = toolFree ? { mode: null, dropped: [] } : modeFor(a.grant);
  if (dropped.length) process.stderr.write(`[codemie-web] tool(s) granted but not declared by this runner, dropped: ${dropped.join(' ')}\n`);
  let integration = null;
  if (mode) {
    if (!a.root || !fs.existsSync(a.root)) throw Object.assign(new Error(`a ${mode} plugin needs the codeline root (--root), got '${a.root || ''}'`), { statusCode: null });
    // Reading may span the run's estate (--read-root, see runner.sh); writing never leaves the codeline.
    const root = mode === 'ro' && a['read-root'] && fs.existsSync(a['read-root']) ? a['read-root'] : a.root;
    a.pluginRoot = root;
    // THE PIPELINE'S OWN TOOLS, hosted by the local plugin beside its file tools (declared:
    // hostedToolPlugins, paths relative to orchestrations/).
    const decl = declaration(env);
    const readOnly = !!(decl.plugins.find((p) => p.mode === mode) || {}).readOnly;
    integration = await ensurePlugin(c, { codeline: a.codeline, mode, root },
      { ...env, EPAM_CODEMIE_HOSTED_TOOLS: JSON.stringify(decl.hostedToolPlugins), EPAM_CODEMIE_HOSTED_SAFE_ONLY: readOnly ? '1' : '' });
  }
  // THE AGENT'S STANDING INSTRUCTIONS, as the hub resolved them for this call (lib/agent-si.js).
  const siFile = env.EPAM_SI_FILE || '';
  const si = siFile && fs.existsSync(siFile) ? fs.readFileSync(siFile, 'utf8') : '';
  const { id, name } = await ensureAssistant(c, { codeline: a.codeline, agent: a.agent, integration, model: a.model, si }, env);
  process.stderr.write(`[codemie-web] ${name} (${id}) model ${a.model}${mode ? `; plugin ${mode} at ${a.pluginRoot}` : '; no tools'}\n`);
  const params = { text: prompt, llm_model: a.model, history: [], stream: false, save_history: false };
  if (a.schema) params.output_schema = JSON.parse(fs.readFileSync(a.schema, 'utf8'));
  return c.assistants.chat(id, params);
}

module.exports = { invoke, modeFor, declaration };

if (require.main === module) {
  const a = args(process.argv.slice(2));
  for (const req of ['prompt-file', 'model', 'agent', 'codeline', 'result']) {
    if (!a[req]) { process.stderr.write(`[codemie-web] --${req} is required\n`); process.exit(2); }
  }
  invoke(a).then((r) => judge({ r, model: a.model }), (err) => judge({ err, model: a.model })).then((res) => {
    fs.mkdirSync(path.dirname(a.result), { recursive: true });
    fs.writeFileSync(a.result, `${JSON.stringify(res)}\n`);
    if (res.is_error) {
      process.stderr.write(`[codemie-web] call failed (${res.error.class}${res.error.statusCode ? ` ${res.error.statusCode}` : ''}): ${res.error.message}\n`);
      process.exit(1);
    }
    process.stdout.write(res.result);
  });
}
