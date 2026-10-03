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
    if (root) process.stdout.write(`${name}\t${root}\n`);
  }
} catch { process.exit(0); }
