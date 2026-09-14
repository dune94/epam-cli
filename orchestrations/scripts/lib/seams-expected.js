#!/usr/bin/env node
/**
 * WHICH REGISTRY SEAMS A PROJECT'S RUN IS EXPECTED TO EXECUTE — from the registry's own declarations.
 *
 * A seam declares the modes it applies to (`appliesTo`: brownfield, greenfield, multi-codeline);
 * absent, it applies everywhere. A project's modes are read from its config: EPAM_BROWNFIELD
 * decides brownfield/greenfield, and the codelines it declares decide multi-codeline. Nothing here
 * names a seam; the £0 harness judges "every declared seam executed" against this set, so a seam
 * that cannot run on this kind of project is neither counted as missing nor quietly dropped — it
 * is listed with the declaration that excludes it.
 *
 *   node seams-expected.js <registry.json> <project config dir>  → { modes, expected, excluded: {seam: why} }
 *
 * The project's base env file is resolved through the provider-set registry (projectEnvFiles),
 * never spelled here.
 */
'use strict';
const fs = require('fs');

/**
 * How many stories the project declares: its tracker issues (a tracker-sourced project) else its
 * authored PRD. The synthesiser puts a single-story run on main on purpose (synthesize-prd-from-
 * jira.js: defaultGroup = totalStoryCount <= 1 ? 'main' : 'primary'), and seams that route or
 * bridge worktree stories never run there — a mode of the project's own data, not of its env.
 */
function projectStoryCount(projectDir) {
  if (!projectDir) return 0;
  try {
    const t = `${projectDir}/tracker-issues.json`;
    if (fs.existsSync(t)) { const a = JSON.parse(fs.readFileSync(t, 'utf8')); return Array.isArray(a) ? a.length : 0; }
    const p = `${projectDir}/prd.authored.json`;
    if (fs.existsSync(p)) return (JSON.parse(fs.readFileSync(p, 'utf8')).stories || []).length;
  } catch { return 0; }
  return 0;
}

function projectModes(configText, projectDir) {
  const get = (k) => { const m = String(configText).match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const modes = new Set([get('EPAM_BROWNFIELD') === '1' ? 'brownfield' : 'greenfield']);
  const root = get('JIRA_CODELINE_ROOT');
  let codelines = 0;
  try { if (root && fs.existsSync(root)) codelines = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(`${root}/${d.name}/.git`)).length; } catch { codelines = 0; }
  if (codelines > 1) modes.add('multi-codeline');
  if (projectStoryCount(projectDir) > 1) modes.add('multi-story');
  return modes;
}

function expectedSeams(profiles, modes) {
  const expected = []; const excluded = {};
  for (const [seam, p] of Object.entries(profiles || {})) {
    const applies = Array.isArray(p && p.appliesTo) ? p.appliesTo : null;
    if (!applies || applies.some((m) => modes.has(m))) expected.push(seam);
    else excluded[seam] = `applies to ${applies.join('/')} only${p._whyAppliesTo ? ` — ${p._whyAppliesTo}` : ''}`;
  }
  return { expected: expected.sort(), excluded };
}

module.exports = { projectModes, expectedSeams, projectStoryCount };

if (require.main === module) {
  const [reg, cfg] = process.argv.slice(2);
  if (!reg || !cfg) { process.stderr.write('usage: seams-expected.js <registry.json> <project config dir>\n'); process.exit(2); }
  const profiles = JSON.parse(fs.readFileSync(reg, 'utf8')).profiles || {};
  // eslint-disable-next-line global-require
  const { projectEnvFiles } = require('./llm-settings-resolve.js');
  const files = projectEnvFiles(cfg);
  if (!files) { process.stderr.write(`no provider-set registry resolves the env files of ${cfg}\n`); process.exit(2); }
  const modes = projectModes(fs.readFileSync(files.base, 'utf8'), cfg);
  process.stdout.write(JSON.stringify({ modes: [...modes], ...expectedSeams(profiles, modes) }) + '\n');
}
