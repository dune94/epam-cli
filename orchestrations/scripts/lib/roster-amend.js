#!/usr/bin/env node
/**
 * THE ONE APPLIER OF IN-RUN IDENTITY AMENDMENTS — into the project roster, where every SI is read.
 *
 * Operator, 2026-09-30: "Self heal MUST work", and yes to amendments landing in the roster. Agents
 * that teach another agent a skill mid-run (the pre-phase skill assessor, profile-augmentor,
 * skills-coordinator, post-failure-analyst) wrote into profiles.json, which no agent's SI is read
 * from since the SI convergence. They now REPORT the addition; this applies it to the entry the SI
 * resolver reads (lib/agent-si.js): the agent's own roster entry, else its seam's. The base text is
 * never edited — additions are appended under one marked section — and the roster is re-derived at
 * every fresh launch, so nothing lingers across runs (operator, 2026-08-12).
 *
 *   node roster-amend.js <agent> <source> <text>   EPAM_PROJECT_CONFIG_DIR names the project
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SECTION = '## Learned in this run';

function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST' || Date.now() > deadline) throw new Error(`[roster-amend] cannot lock ${file}: ${e.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
}

function amendAgent({ projectConfigDir, agent, text, source, registryFile }) {
  if (!agent || !String(text || '').trim()) throw new Error('[roster-amend] an amendment needs an agent and a text');
  const file = path.join(String(projectConfigDir || ''), 'roster.json');
  if (!fs.existsSync(file)) throw new Error(`[roster-amend] no project roster at ${file} — '${agent}' cannot be amended before the roster exists`);
  return withLock(file, () => {
    const roster = JSON.parse(fs.readFileSync(file, 'utf8'));
    const agents = roster.agents || {};
    let key = agents[agent] ? agent : '';
    if (!key) {
      const { resolveSeam, registryPath } = require('./seam-invocation.js');
      let seam = '';
      try { seam = resolveSeam(agent, registryFile || registryPath(), { ignoreXref: true }); } catch { seam = ''; }
      if (seam && agents[seam]) key = seam;
    }
    if (!key) throw new Error(`[roster-amend] '${agent}' has no entry in the project roster (${file}) — the addition was not applied`);
    const entry = agents[key];
    const persona = String(entry.persona || '');
    const line = `- ${String(text).trim()}${source ? ` (${source})` : ''}`;
    if (persona.includes(String(text).trim())) return { entry: key, added: false };
    entry.persona = persona.includes(SECTION) ? `${persona}\n${line}` : `${persona}\n\n${SECTION}\n${line}`;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(roster, null, 2));
    fs.renameSync(tmp, file);
    return { entry: key, added: true };
  });
}

module.exports = { amendAgent, SECTION };

if (require.main === module) {
  const [agent, source, text] = process.argv.slice(2);
  try {
    const r = amendAgent({ projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR, agent, text, source });
    process.stdout.write(`${JSON.stringify(r)}\n`);
  } catch (e) {
    process.stderr.write(`${(e && e.message) || e}\n`);
    process.exit(1);
  }
}
