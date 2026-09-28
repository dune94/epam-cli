'use strict';
/**
 * ONE PIPELINE CALL AS A CODEMIE WEB ASSISTANT — the codemie-web stack's runner.
 *
 *   node invoke.js --prompt-file F --model M --agent A --codeline C --result R.json
 *                  [--grant "read_file,search,…"] [--root DIR] [--schema S.json]
 *
 * Called by both paths a model call takes — the seam hub (llm-handler.sh) and the story writer
 * (lib/story-attempt.sh), through lib/codemie-web-runner.sh — so a codemie-web call is built and read
 * in one place, like a copilot one.
 *
 *   grant   the seam's tool grant (EPAM_ALLOWED_TOOLS). write_file or bash → the development plugin
 *           (rw); read_file/list_files/search only → the read-only plugin (ro); none → no plugin.
 *   root    the codeline the plugin is rooted at (the lane's clone). Required when there is a grant.
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

const WRITE_GRANTS = new Set(['write_file', 'bash']);
const READ_GRANTS = new Set(['read_file', 'list_files', 'search']);

/** Which plugin a grant binds: rw, ro, or none. */
function modeFor(grant) {
  const g = String(grant || '').split(/[\s,]+/).filter(Boolean);
  if (g.some((t) => WRITE_GRANTS.has(t))) return 'rw';
  if (g.some((t) => READ_GRANTS.has(t))) return 'ro';
  return null;
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
  const mode = modeFor(a.grant);
  let integration = null;
  if (mode) {
    if (!a.root || !fs.existsSync(a.root)) throw Object.assign(new Error(`a ${mode} grant needs the codeline root (--root), got '${a.root || ''}'`), { statusCode: null });
    integration = await ensurePlugin(c, { codeline: a.codeline, mode, root: a.root }, env);
  }
  const { id, name } = await ensureAssistant(c, { codeline: a.codeline, agent: a.agent, integration, model: a.model }, env);
  process.stderr.write(`[codemie-web] ${name} (${id}) model ${a.model}${mode ? `; plugin ${mode} at ${a.root}` : '; no tools'}\n`);
  const params = { text: prompt, llm_model: a.model, history: [], stream: false, save_history: false };
  if (a.schema) params.output_schema = JSON.parse(fs.readFileSync(a.schema, 'utf8'));
  return c.assistants.chat(id, params);
}

module.exports = { invoke, modeFor };

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
