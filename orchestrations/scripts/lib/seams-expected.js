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

function projectModes(configText) {
  const get = (k) => { const m = String(configText).match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  const modes = new Set([get('EPAM_BROWNFIELD') === '1' ? 'brownfield' : 'greenfield']);
  const root = get('JIRA_CODELINE_ROOT');
  let codelines = 0;
  try { if (root && fs.existsSync(root)) codelines = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(`${root}/${d.name}/.git`)).length; } catch { codelines = 0; }
  if (codelines > 1) modes.add('multi-codeline');
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

module.exports = { projectModes, expectedSeams };

if (require.main === module) {
  const [reg, cfg] = process.argv.slice(2);
  if (!reg || !cfg) { process.stderr.write('usage: seams-expected.js <registry.json> <project config dir>\n'); process.exit(2); }
  const profiles = JSON.parse(fs.readFileSync(reg, 'utf8')).profiles || {};
  // eslint-disable-next-line global-require
  const { projectEnvFiles } = require('./llm-settings-resolve.js');
  const files = projectEnvFiles(cfg);
  if (!files) { process.stderr.write(`no provider-set registry resolves the env files of ${cfg}\n`); process.exit(2); }
  const modes = projectModes(fs.readFileSync(files.base, 'utf8'));
  process.stdout.write(JSON.stringify({ modes: [...modes], ...expectedSeams(profiles, modes) }) + '\n');
}
