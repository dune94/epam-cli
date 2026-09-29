'use strict';
/**
 * ONE STORED CODEMIE ASSISTANT PER (CODELINE, AGENT) — named, placed and kept private by config.
 *
 * Operator, 2026-09-28: "Do not share agents codemie web with the Team until we have made brownfield
 * and greenfield green with this new provider. Keep agents local, to my name only. but use a common
 * naming for agents 'Pipeline [codeline] [agent name]'."
 *
 * config/codemie-web.json decides the name template, the project (empty = the signed-in user's
 * personal project) and `shared`. An assistant is created on first use and updated when its binding
 * changes; ids are cached in the install so a run does not list every assistant on every call. The
 * stored assistant carries the persona and the toolkit binding only — the rendered prompt travels
 * with each chat, so a template change never needs an assistant rewrite.
 */
const fs = require('fs');
const path = require('path');
const { home } = require('./paths.js');

const CONFIG = path.join(__dirname, '..', '..', '..', 'config', 'codemie-web.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

/** "Pipeline {codeline} {agent}" with the parts filled; whitespace-normalised. */
function assistantName(codeline, agent, cfg = readConfig()) {
  if (!codeline || !agent) throw new Error(`[codemie-web] an assistant needs a codeline and an agent (got '${codeline}', '${agent}')`);
  return cfg.nameTemplate.replace('{codeline}', codeline).replace('{agent}', agent).replace(/\s+/g, ' ').trim();
}

/** The project assistants live in: the configured one, else the signed-in user's personal project. */
async function project(c, cfg = readConfig()) {
  if (cfg.project) return cfg.project;
  const me = await c.users.aboutMe();
  if (!me || !me.username) throw new Error('[codemie-web] could not read the signed-in CodeMie user for the personal project');
  return me.username;
}

const PERSONA = 'You are an agent of an automated software delivery pipeline. Each message carries your full '
  + 'instructions for one task; follow them exactly and answer in the form they ask for. When a Plugin tool '
  + 'is available it works on the codeline the task names — use it to read and change files there.';

const cachePath = (env = process.env) => path.join(home(env), 'assistants.json');
const readCache = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };

/** The Plugin toolkit bound to an integration, or none. */
function toolkitsFor(integration) {
  if (!integration) return [];
  return [{ toolkit: 'Plugin', label: '', settings_config: true, is_external: false, settings: integration, tools: [{ name: 'Plugin', label: 'Plugin', settings_config: false }] }];
}

/**
 * The id of the assistant for (codeline, agent), created or updated so that it is bound to
 * `integration` (a CodeMie Plugin integration object, or null for a tool-free agent).
 */
async function ensureAssistant(c, { codeline, agent, integration, model }, env = process.env) {
  const cfg = readConfig();
  const name = assistantName(codeline, agent, cfg);
  const proj = await project(c, cfg);
  const binding = integration ? integration.id : 'none';
  const cp = cachePath(env);
  const cache = readCache(cp);
  const hit = cache[name];
  if (hit && hit.binding === binding && hit.project === proj) return { id: hit.id, name };

  const spec = {
    name, description: `Pipeline agent '${agent}' for codeline '${codeline}'.`, system_prompt: PERSONA,
    project: proj, llm_model_type: model, context: [], toolkits: toolkitsFor(integration),
    conversation_starters: [], mcp_servers: [], assistant_ids: [], shared: cfg.shared === true,
  };
  const find = async () => ((await c.assistants.list({ minimal_response: true, per_page: 500 })) || []).find((a) => a.name === name && (!a.project || a.project === proj));
  let found = hit ? { id: hit.id } : await find();
  if (found) await c.assistants.update(found.id, spec);
  else { await c.assistants.create(spec); found = await find(); }
  if (!found || !found.id) throw new Error(`[codemie-web] assistant '${name}' was not found after it was created`);
  cache[name] = { id: found.id, binding, project: proj };
  fs.writeFileSync(cp, `${JSON.stringify(cache, null, 1)}\n`);
  return { id: found.id, name };
}

module.exports = { assistantName, ensureAssistant, project, readConfig, toolkitsFor, PERSONA };
