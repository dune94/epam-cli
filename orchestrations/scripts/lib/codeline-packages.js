'use strict';
/**
 * WHAT EACH CODELINE OF A STORY PROVIDES, AND WHICH RANGE EACH DECLARES FOR WHAT ITS SIBLINGS PROVIDE.
 *
 * Live 2026-10-02, AMSD-2974: whether a site's declared range takes a shared library's change was
 * left to the library lane's detective choosing to report the version; twice it did not, and one
 * site then assumed its ^7 range would take an 8.x change. These are facts on disk. Each manifest is
 * read by the ecosystem provider that owns it (ecosystems/*.js, through lib/ecosystem-registry.js):
 * describe() for name and version, depRanges() for declared ranges. A codeline whose folder or
 * manifest cannot be read is reported with nothing known, never guessed. What the facts MEAN — does
 * this range take that change — is the detective's judgement, not this module's.
 */
const fs = require('fs');
const path = require('path');
const { allManifests } = require('./ecosystem-registry.js');

function readManifest(root) {
  if (!root) return null;
  for (const eco of allManifests()) {
    const file = path.join(root, eco.file);
    if (!fs.existsSync(file)) continue;
    try { return { eco, text: fs.readFileSync(file, 'utf8') }; } catch { return null; }
  }
  return null;
}

/**
 * @param {object}   prd        the lane's PRD (project.outputDirs: [{codeline, path}])
 * @param {string[]} codelines  the story's codelines
 * @returns {Array<{codeline, provides: {name, version}|null, declares: object}>}
 */
function codelinePackages(prd, codelines) {
  const dirs = (prd && prd.project && Array.isArray(prd.project.outputDirs)) ? prd.project.outputDirs : [];
  const rootOf = (cl) => (dirs.find((d) => d && d.codeline === cl) || {}).path || '';
  const read = (codelines || []).map((cl) => {
    const m = readManifest(rootOf(cl));
    let provides = null;
    let ranges = {};
    if (m) {
      try {
        const d = typeof m.eco.describe === 'function' ? m.eco.describe(m.text) : null;
        if (d && d.packageName) provides = { name: d.packageName, version: d.version || '' };
      } catch { provides = null; }
      try { ranges = (typeof m.eco.depRanges === 'function' && m.eco.depRanges(m.text)) || {}; } catch { ranges = {}; }
    }
    // ITS RELEASES, from its own history: a consumer locked to an older line receives a change only if
    // the provider ships it there too, and the base of that line is the newest release on it (2026-10-06).
    let releases = [];
    if (provides) {
      try {
        releases = require('child_process').execFileSync('git', ['-C', rootOf(cl), 'tag', '--sort=-v:refname'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          .split('\n').map((t) => t.trim()).filter(Boolean);
      } catch { releases = []; }
    }
    return { codeline: cl, provides, ranges, releases };
  });
  return read.map((r) => {
    const declares = {};
    for (const o of read) {
      if (!o.provides) continue;
      if (Object.prototype.hasOwnProperty.call(r.ranges, o.provides.name)) declares[o.provides.name] = String(r.ranges[o.provides.name]);
    }
    return { codeline: r.codeline, provides: r.provides, declares, releases: r.releases };
  });
}

module.exports = { codelinePackages };
