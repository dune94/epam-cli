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
 *   3. the codemie-plugins environment the installer provisions can host both plugins (plugin_host.py
 *      --check builds each toolkit, connecting nothing) — every tool grant needs it.
 *
 * Reads only: no assistant, integration or plugin is created.
 */
const path = require('path');
const { client } = require('./client.js');
const { project } = require('./registry.js');
const { command } = require('./plugins.js');

/** The models the resolved ladder can climb to — asked of lib/handlers/ladder-models.js, their one definition. */
function ladderModels(env = process.env) {
  const out = require('child_process').execFileSync(process.execPath,
    [path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'handlers', 'ladder-models.js')], { encoding: 'utf8', env });
  return out ? JSON.parse(out) : [];
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

  const [python, [host]] = command('ro', path.sep, '', env);
  const hosted = require('child_process').spawnSync(python, [host, '--check'], { encoding: 'utf8', env });
  if (hosted.status !== 0) {
    const why = hosted.error ? hosted.error.code : `exit ${hosted.status}`;
    throw new Error(`the codemie-plugins environment cannot host a plugin (${python}: ${why}) — the installer provisions codemie-plugins for the codemie-web stack; re-run it`);
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
