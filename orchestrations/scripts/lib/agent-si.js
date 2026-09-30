#!/usr/bin/env node
/**
 * THE STANDING INSTRUCTIONS AN AGENT RECEIVES — one resolver, read by every path to a model.
 *
 * Operator, 2026-09-29: "Bases and derived si must be matched to each seam. No deviations." and
 * "Ensure each provider has a proper agent si transit." An agent's SI is its entry in the project
 * roster: a seam's derived SI (keyed by the seam) or a minted agent's own (ancestored to its seam).
 * Otherwise the SEAM is the one this call's invocation resolved (seamInvocationEnv exports it as
 * EPAM_SEAM — the seam that decided its ladder and budget); only a call with no invocation env
 * resolves one from the agent's name, through the registry's own resolver. A cost label used as a
 * name (spec-mode-runner does this) would otherwise hand the agent another seam's SI.
 *
 * BEFORE THE ROSTER EXISTS the project has no derived SI yet — the seams that build it run first —
 * so the seam's BASE SI from the registry is what it receives. Once the roster exists, an agent it
 * cannot answer is a stated failure: there is no fallback to the base, or to nothing.
 *
 * WHAT TRAVELS is the agent's SI followed by the pipeline-wide constitution (lib/agent-contract.js,
 * filled with PROJECT_ROOT) — the one system-prompt channel a runner has carries both.
 *
 *   node agent-si.js <agent> <projectConfigDir> <outFile>   writes SI + constitution to outFile (EPAM_SEAM honoured)
 */
'use strict';
const fs = require('fs');
const path = require('path');

function siForAgent(agent, projectConfigDir, registryFile, invocationSeam) {
  if (!agent) throw new Error('[agent-si] no agent named — an anonymous call has no standing instructions');
  const { registryPath, resolveSeam } = require('./seam-invocation.js');
  const regFile = registryFile || registryPath();
  const rosterFile = path.join(String(projectConfigDir || ''), 'roster.json');
  const seamOf = () => (invocationSeam && String(invocationSeam).trim())
    || resolveSeam(agent, regFile, { ignoreXref: true });
  if (projectConfigDir && fs.existsSync(rosterFile)) {
    const agents = (JSON.parse(fs.readFileSync(rosterFile, 'utf8')) || {}).agents || {};
    const own = agents[agent];
    if (own && typeof own.persona === 'string' && own.persona.trim()) return own.persona;
    const seam = seamOf();
    const bySeam = seam && agents[seam];
    if (bySeam && typeof bySeam.persona === 'string' && bySeam.persona.trim()) return bySeam.persona;
    throw new Error(`[agent-si] '${agent}' (seam '${seam || '?'}') has no standing instructions in the project roster ${rosterFile}`);
  }
  const seam = seamOf();
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const si = seam && reg.profiles && reg.profiles[seam] && reg.profiles[seam].si;
  if (typeof si === 'string' && si.trim()) return si;
  throw new Error(`[agent-si] seam '${seam || '?'}' of '${agent}' declares no si in ${regFile}`);
}

/** The standing instructions as they travel: the agent's SI, then the pipeline-wide constitution. */
function composedSi(agent, projectConfigDir, registryFile, invocationSeam, projectRoot) {
  const { constitution } = require('./agent-contract.js');
  const rules = constitution(projectRoot);
  const si = siForAgent(agent, projectConfigDir, registryFile, invocationSeam);
  return rules ? `${si}\n\n${rules}` : si;
}

module.exports = { siForAgent, composedSi };

if (require.main === module) {
  const [agent, projectConfigDir, outFile] = process.argv.slice(2);
  try {
    const si = composedSi(agent, projectConfigDir, undefined, process.env.EPAM_SEAM, process.env.PROJECT_ROOT);
    fs.writeFileSync(outFile, si, 'utf8');
  } catch (e) {
    process.stderr.write(`${(e && e.message) || e}\n`);
    process.exit(1);
  }
}
