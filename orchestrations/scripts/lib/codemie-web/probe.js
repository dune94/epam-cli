'use strict';
/**
 * CAN THIS MACHINE RUN THE CODEMIE WEB STACK? — the set's signInProbe (config/provider-sets.json).
 *
 *   node probe.js      exit 0 and one line per check on stdout; exit 1 with the failing check on stderr
 *
 * Three facts a run needs before its first call, each of which otherwise fails mid-run on every rung:
 *   1. the CodeMie session is signed in (the CLI's SSO), and whose personal project assistants go to;
 *   2. every model the resolved ladder can climb to is in CodeMie's catalog — a missing one is a
 *      rung the ladder would climb onto and be refused;
 *   3. the codemie-plugins environment the installer provisions is present — a writer's grant needs it.
 *
 * Reads only: no assistant, integration or plugin is created.
 */
const fs = require('fs');
const path = require('path');
const { client } = require('./client.js');
const { project } = require('./registry.js');
const { command } = require('./plugins.js');

function ladderModels() {
  const { resolveLlmSettings } = require('../llm-settings-resolve.js');
  const st = resolveLlmSettings() || {};
  const order = Array.isArray(st.ladderTierOrder) ? st.ladderTierOrder : Object.keys(st.ladders || {});
  const out = new Set();
  for (const tier of order) {
    const t = (st.ladders || {})[tier];
    if (!t) continue;
    if (t.startModel) out.add(t.startModel);
    for (const hop of (t.modelLadder || [])) { if (hop && hop.from) out.add(hop.from); if (hop && hop.to) out.add(hop.to); }
  }
  return [...out];
}

const catalogIds = (list) => new Set((Array.isArray(list) ? list : []).flatMap((m) => [m && m.base_name, m && m.deployment_name, m && m.id, m && m.label].filter(Boolean)));

async function probe(env = process.env) {
  const lines = [];
  const c = await client(env);
  const proj = await project(c);
  lines.push(`signed in; assistants go to project '${proj}'`);

  const want = ladderModels();
  if (!want.length) throw new Error('the resolved ladder declares no models — nothing to check against the catalog');
  const have = catalogIds(await c.llms.list());
  const missing = want.filter((m) => !have.has(m));
  if (missing.length) throw new Error(`ladder model(s) not in CodeMie's catalog: ${missing.join(', ')} — the ladder would climb onto a refusal`);
  lines.push(`every ladder model is in the catalog (${want.join(', ')})`);

  for (const mode of ['rw', 'ro']) {
    const [bin] = command(mode, path.sep, env);
    if (!fs.existsSync(bin)) throw new Error(`${bin} is missing — the installer provisions codemie-plugins for the codemie-web stack; re-run it`);
  }
  lines.push('codemie-plugins environment present');
  return lines;
}

module.exports = { probe, ladderModels };

if (require.main === module) {
  probe().then(
    (lines) => { process.stdout.write(`${lines.join('\n')}\n`); },
    (err) => { process.stderr.write(`[codemie-web] ${err.message || err}\n`); process.exit(1); },
  );
}
