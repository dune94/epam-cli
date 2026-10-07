#!/usr/bin/env node
/**
 * WHICH OF THIS STORY'S OTHER CODELINES PROVIDE A PACKAGE THIS CODELINE DECLARES.
 *
 * A story spanning a shared library and the sites that consume it changes the library in its own
 * lane; a site lane must build and test against THAT change, not the release it has installed. The
 * facts come from lib/codeline-packages.js (each codeline's manifest, read by its ecosystem
 * provider), scoped to the codelines the story spans — never the whole estate, never configured.
 *
 *   argv[2]  the lane's PRD (project.outputDirs: [{codeline, path}])
 *   argv[3]  this codeline's root
 *   stdout   one "packageName<TAB>providerRoot" line per sibling package this codeline declares
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { codelinePackages } = require('../codeline-packages.js');

try {
  const prd = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const here = path.resolve(process.argv[3] || '');
  const dirs = (prd.project && Array.isArray(prd.project.outputDirs)) ? prd.project.outputDirs : [];
  const mine = dirs.find((d) => d && d.path && path.resolve(d.path) === here);
  if (!mine) process.exit(0);
  const facts = codelinePackages(prd, dirs.map((d) => d.codeline));
  const me = facts.find((f) => f.codeline === mine.codeline);
  for (const name of Object.keys((me && me.declares) || {})) {
    const provider = facts.find((f) => f.codeline !== mine.codeline && f.provides && f.provides.name === name);
    const root = provider && (dirs.find((d) => d.codeline === provider.codeline) || {}).path;
    // THE LINE THIS CONSUMER RECEIVES (the story's plan): a version shipped on a release line off the provider's own
    // base is built from that line's story branch — suffix and story id, for the caller to name it.
    let suffix = ''; let story = '';
    for (const s of prd.stories || []) {
      for (const p of ((s && s.overallPlan && s.overallPlan.packages) || [])) {
        if (p.package !== name) continue;
        const c = (p.consumers || []).find((x) => x && x.codeline === mine.codeline);
        const l = c && (p.releaseLines || []).find((x) => x && x.version === c.receivesVia);
        if (l && l.onCodelineBase === false && !suffix) { suffix = `-${String(l.line).replace(/[^A-Za-z0-9._-]/g, '-')}`; story = s.id; }
      }
    }
    if (root) process.stdout.write(`${name}\t${root}\t${suffix}\t${story}\n`);
  }
} catch { process.exit(0); }
