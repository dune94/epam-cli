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
 * stored assistant carries its agent's instructions (instructionsFor) and the toolkit binding — the
 * rendered prompt travels with each chat, so a template change never needs an assistant rewrite, and
 * a changed persona (the roster is regenerated each run) updates the assistant on its next call.
 */
const crypto = require('crypto');
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

const SCRIPTS_LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib');

/**
 * WHO THE ASSISTANT IS: its agent's own generated persona, then its seam's description.
 *
 * The seam is the agent's (seam-invocation.js resolveSeam); the persona is the one that seam declares
 * it speaks as (invocation-profiles.json `persona`), read where the pipeline's personas live
 * (agent-roster.js agentPersona: the project roster once it carries the agent, the install's profiles
 * before); the description is the seam's `_what`. A seam that declares no persona — its persona varies
 * per call and travels in the prompt — is its description alone. Nothing is invented for an agent
 * the registry does not know: its instructions are empty.
 */
function instructionsFor(agent, env = process.env) {
  const agentsDir = env.EPAM_AGENTS_DIR || path.join(SCRIPTS_LIB, '..', '..', 'agents');
  const { resolveSeam, registryPath } = require(path.join(SCRIPTS_LIB, 'seam-invocation.js'));
  const { agentPersona } = require(path.join(SCRIPTS_LIB, 'agent-roster.js'));
  let entry = {};
  try {
    const file = registryPath(agentsDir);
    entry = (JSON.parse(fs.readFileSync(file, 'utf8')).profiles || {})[resolveSeam(agent, file)] || {};
  } catch { entry = {}; }
  const description = String(entry._what || '').trim();
  const persona = entry.persona ? String(agentPersona(entry.persona, agentsDir, env.EPAM_PROJECT_CONFIG_DIR) || '').trim() : '';
  return { system_prompt: [persona, description].filter(Boolean).join('\n\n'), description };
}

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
  const { system_prompt, description } = instructionsFor(agent, env);
  const spec = {
    name, description, system_prompt,
    project: proj, llm_model_type: model, context: [], toolkits: toolkitsFor(integration),
    conversation_starters: [], mcp_servers: [], assistant_ids: [], shared: cfg.shared === true,
  };
  // What the stored assistant says of itself — the model travels per chat, so it is not part of it.
  const digest = crypto.createHash('sha256').update(JSON.stringify({ ...spec, llm_model_type: undefined })).digest('hex');
  if (hit && hit.digest === digest && hit.project === proj) return { id: hit.id, name };

  const find = async () => ((await c.assistants.list({ minimal_response: true, per_page: 500 })) || []).find((a) => a.name === name && (!a.project || a.project === proj));
  let found = hit ? { id: hit.id } : await find();
  if (found) await c.assistants.update(found.id, spec);
  else { await c.assistants.create(spec); found = await find(); }
  if (!found || !found.id) throw new Error(`[codemie-web] assistant '${name}' was not found after it was created`);
  cache[name] = { id: found.id, binding, project: proj, digest };
  fs.writeFileSync(cp, `${JSON.stringify(cache, null, 1)}\n`);
  return { id: found.id, name };
}

module.exports = { assistantName, ensureAssistant, project, readConfig, toolkitsFor, instructionsFor };
