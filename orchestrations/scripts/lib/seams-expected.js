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
function projectStoryCount(projectDir, configText) {
  if (!projectDir) return 0;
  const get = (k) => { const m = String(configText || '').match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  try {
    const t = `${projectDir}/tracker-issues.json`;
    if (fs.existsSync(t)) { const a = JSON.parse(fs.readFileSync(t, 'utf8')); return Array.isArray(a) ? a.length : 0; }
    const p = `${projectDir}/prd.authored.json`;
    if (fs.existsSync(p)) return (JSON.parse(fs.readFileSync(p, 'utf8')).stories || []).length;
    // A project whose PRD is named by PRD_CANONICAL in its config (relative to the install root,
    // else absolute): read as 0 stories, the router was wrongly excluded on greenfield-proof and a
    // GREEN verdict claimed 32/32 where the previous runs executed 33 (2026-09-14).
    const canon = get('PRD_CANONICAL');
    if (canon) {
      const path = require('path');
      const abs = path.isAbsolute(canon) ? canon : path.resolve(projectDir, '..', '..', '..', canon);
      if (fs.existsSync(abs)) return (JSON.parse(fs.readFileSync(abs, 'utf8')).stories || []).length;
    }
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
  if (projectStoryCount(projectDir, configText) > 1) modes.add('multi-story');
  return modes;
}

// A SEAM THE PROJECT OPTS OUT OF IS NOT EXPECTED. The registry lets a seam declare the project
// setting that switches it off (`optOut: {env, value}`); a project whose config declares that
// value is not expected to run it, and the reason is listed with the exclusion.
function configValue(configText, key) {
  const m = String(configText || '').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

// A SEAM A CACHE HOLDS IS NOT EXPECTED WHEN THE CACHE WAS USED. A seam may declare `cachedBy`
// (e.g. "roster"); a run that reused that cache did not execute it, and says so.
function expectedSeams(profiles, modes, configText, reused) {
  const expected = []; const excluded = {};
  const reusedSet = new Set(Array.isArray(reused) ? reused : []);
  for (const [seam, p] of Object.entries(profiles || {})) {
    if (p && p.cachedBy && reusedSet.has(p.cachedBy)) {
      excluded[seam] = `cached by the ${p.cachedBy}, which this run reused${p._whyCachedBy ? ` — ${p._whyCachedBy}` : ''}`;
      continue;
    }
    const applies = Array.isArray(p && p.appliesTo) ? p.appliesTo : null;
    if (applies && !applies.some((m) => modes.has(m))) {
      excluded[seam] = `applies to ${applies.join('/')} only${p._whyAppliesTo ? ` — ${p._whyAppliesTo}` : ''}`;
      continue;
    }
    const opt = p && p.optOut && typeof p.optOut === 'object' ? p.optOut : null;
    if (opt && opt.env && configText !== undefined && configValue(configText, opt.env) === String(opt.value)) {
      excluded[seam] = `the project declares ${opt.env}=${opt.value}${opt._why ? ` — ${opt._why}` : ''}`;
      continue;
    }
    expected.push(seam);
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
  const configText = fs.readFileSync(files.base, 'utf8');
  const modes = projectModes(configText, cfg);
  const reused = String(process.env.EPAM_SEAMS_REUSED || '').split(',').map((x) => x.trim()).filter(Boolean);
  process.stdout.write(JSON.stringify({ modes: [...modes], ...expectedSeams(profiles, modes, configText, reused) }) + '\n');
}
