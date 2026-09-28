'use strict';
/**
 * THE LOCAL REACH OF A CODEMIE WEB ASSISTANT — one CodeMie Plugin per (codeline, mode).
 *
 * Proven 2026-09-28: a stored assistant's Plugin toolkit calls tools on this machine through a local
 * `codemie-plugins` process that connects OUT to CodeMie's plugin engine; the engine accepts the
 * process only once its key is registered as a `Plugin` integration.
 *
 *   rw  the codemie-plugins `development` toolkit (read, list, recursive list, write, git, run-command)
 *   ro  lib/codemie-web/plugin_ro.py (list, recursive list, read, search) — nothing that writes or runs
 *
 * Per (codeline, mode): a key minted once and kept in the install (0600, never printed); an
 * integration named like the assistants ("Pipeline <codeline> <mode>"); a process rooted at the
 * lane's clone with its OWN HOME (codemie-plugins hard-codes ~/.codemie/config.json, which the CodeMie
 * CLI also uses). Started on first use, reused while alive at the same root, stopped by stopAll() —
 * which the run's exit handler calls on every exit, including a pause.
 *
 * CLI:  node plugins.js stop-all
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readConfig, assistantName, project } = require('./registry.js');
const { INSTALL_ROOT, home } = require('./paths.js');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v, mode) => { fs.writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`, mode ? { mode } : undefined); if (mode) fs.chmodSync(p, mode); };
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The key for (codeline, mode), minted once. */
function keyFor(codeline, mode, env = process.env) {
  const p = path.join(home(env), 'keys.json');
  const keys = readJson(p, {});
  const k = `${codeline}:${mode}`;
  if (!keys[k]) { keys[k] = crypto.randomUUID(); writeJson(p, keys, 0o600); }
  return keys[k];
}

/** The Plugin integration holding that key, registered once. */
async function ensureIntegration(c, codeline, mode, env = process.env) {
  const alias = assistantName(codeline, mode);
  const find = async () => ((await c.integrations.list({ setting_type: 'user' })) || []).find((i) => i.alias === alias);
  let integ = await find();
  if (!integ) {
    await c.integrations.create({ project_name: await project(c), credential_type: 'Plugin', setting_type: 'user', alias, credential_values: [{ key: 'plugin_key', value: keyFor(codeline, mode, env) }] });
    integ = await find();
  }
  if (!integ) throw new Error(`[codemie-web] integration '${alias}' was not found after it was created`);
  return integ;
}

/** The codemie-plugins environment: the active set's pythonEnv (provider-sets.json), which the installer builds. */
function venvDir(env = process.env) {
  if (env.EPAM_CODEMIE_PLUGINS_VENV) return env.EPAM_CODEMIE_PLUGINS_VENV;
  const reg = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'orchestrations', 'config', 'provider-sets.json'), 'utf8'));
  const set = (reg.sets || {})[env.EPAM_PROVIDER_SET || reg.defaultSet || ''] || {};
  if (!set.pythonEnv || !set.pythonEnv.path) throw new Error(`[codemie-web] the '${env.EPAM_PROVIDER_SET || reg.defaultSet}' set declares no pythonEnv — nothing says where codemie-plugins is installed`);
  return path.resolve(INSTALL_ROOT, set.pythonEnv.path);
}

/** The command that runs a plugin of `mode` rooted at `root`. */
function command(mode, root, env = process.env) {
  const venv = venvDir(env);
  if (mode === 'rw') return [path.join(venv, 'bin', 'codemie-plugins'), ['development', 'run', '--repo-path', root]];
  if (mode === 'ro') return [path.join(venv, 'bin', 'python'), [path.join(__dirname, 'plugin_ro.py'), root]];
  throw new Error(`[codemie-web] unknown plugin mode '${mode}'`);
}

/** Wait until the plugin engine has the process's tools, or fail with what the log said. */
async function waitConnected(log, pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    if (/connected \d+ tools|ready to serve \d+ tools/.test(text)) return;
    if (/Authorization Violation|NATS error/.test(text)) throw new Error(`[codemie-web] plugin refused by the plugin engine — see ${log}`);
    if (!alive(pid)) throw new Error(`[codemie-web] plugin exited before connecting — see ${log}`);
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  throw new Error(`[codemie-web] plugin did not connect within ${Math.round(timeoutMs / 1000)} s — see ${log}`);
}

/** A running, connected plugin of `mode` for `codeline`, rooted at `root`; returns its integration. */
async function ensurePlugin(c, { codeline, mode, root }, env = process.env) {
  const h = home(env);
  const statePath = path.join(h, 'plugins.json');
  const state = readJson(statePath, {});
  const k = `${codeline}:${mode}`;
  const realRoot = fs.realpathSync(root);
  const integration = await ensureIntegration(c, codeline, mode, env);
  const cur = state[k];
  if (cur && cur.root === realRoot && alive(cur.pid)) return integration;
  if (cur && alive(cur.pid) && stop([cur.pid]).length) throw new Error(`[codemie-web] the ${k} plugin at ${cur.root} would not stop (pid ${cur.pid}) — refusing to start a second one`);

  const pluginHome = path.join(h, 'plugin-home', slug(k));
  fs.mkdirSync(pluginHome, { recursive: true });
  fs.mkdirSync(path.join(h, 'logs'), { recursive: true });
  const log = path.join(h, 'logs', `${slug(k)}.log`);
  const [bin, args] = command(mode, realRoot, env);
  if (!fs.existsSync(bin)) throw new Error(`[codemie-web] ${bin} is missing — the installer provisions codemie-plugins for the codemie-web stack`);
  const out = fs.openSync(log, 'w');
  const child = spawn(bin, args, {
    detached: true, stdio: ['ignore', out, out],
    env: { ...env, HOME: pluginHome, PLUGIN_KEY: keyFor(codeline, mode, env), PLUGIN_ENGINE_URI: env.EPAM_CODEMIE_PLUGIN_ENGINE_URI || readConfig().pluginEngineUri },
  });
  child.unref();
  state[k] = { pid: child.pid, root: realRoot, mode, codeline, log, startedAt: new Date().toISOString() };
  writeJson(statePath, state);
  await waitConnected(log, child.pid, Number(env.EPAM_CODEMIE_PLUGIN_CONNECT_MS || 90000));
  return integration;
}

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const signal = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };

/**
 * Stop every plugin this install started — and make sure it is GONE. Safe to call when none runs.
 *
 * The development toolkit shuts down on SIGINT ("Press Ctrl+C to exit gracefully") and ignored a
 * SIGTERM in the 2026-09-28 smoke run, so a plugin (which carries run-command) outlived its run.
 * Escalate INT → TERM → KILL, each with a grace period, and report any that survive.
 */
/** Stop these pids, escalating INT → TERM → KILL with a grace period each; returns the survivors. */
function stop(pids) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
    const left = pids.filter(alive);
    if (!left.length) break;
    for (const p of left) signal(p, sig);
    for (let i = 0; i < 20 && left.some(alive); i += 1) sleep(250);
  }
  return pids.filter(alive);
}

function stopAll(env = process.env) {
  const statePath = path.join(home(env, { create: false }), 'plugins.json');
  if (!fs.existsSync(statePath)) return 0;   // nothing was ever started here: no side effect, no output
  const state = readJson(statePath, {});
  const running = Object.values(state).filter((s) => s && s.pid && alive(s.pid));
  const left = new Set(stop(running.map((s) => s.pid)));
  const survivors = running.filter((s) => left.has(s.pid));
  writeJson(statePath, Object.fromEntries(survivors.map((s) => [`${s.codeline}:${s.mode}`, s])));
  if (survivors.length) throw new Error(`[codemie-web] ${survivors.length} plugin(s) would not stop: ${survivors.map((s) => s.pid).join(', ')}`);
  return running.length;
}

module.exports = { ensurePlugin, ensureIntegration, keyFor, stopAll, command };

if (require.main === module) {
  if (process.argv[2] === 'stop-all') { const n = stopAll(); if (n) process.stderr.write(`[codemie-web] stopped ${n} plugin(s)\n`); }
  else { process.stderr.write('usage: plugins.js stop-all\n'); process.exit(1); }
}
