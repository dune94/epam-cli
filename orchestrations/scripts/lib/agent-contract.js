#!/usr/bin/env node
/**
 * THE PIPELINE-WIDE CONSTITUTION — rendered once, from the catalog, for every agent.
 *
 * config/agent-contract.json → constitution {header, rules[]}: the rules every agent receives after
 * its own standing instructions (filesystem boundary, protected paths, credentials). claude.sh
 * rendered them with its own inline `node -e` and passed the engine directories as an argument;
 * the writer was the only agent that received them. One renderer now (render-prompt-section.js),
 * one declaration of every value it fills: the catalog's own string fields ({engineDirs}) and the
 * run's project root ({projectRoot}). A value the run does not have is left VISIBLE as its
 * placeholder, as the renderer's contract states — never silently emptied.
 *
 *   node agent-contract.js [projectRoot]   prints the rendered constitution
 *   node agent-contract.js --count         prints how many rules it numbers
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { render } = require('./render-prompt-section.js');

const contractPath = () => path.join(__dirname, '..', '..', 'config', 'agent-contract.json');

function readContract(file) {
  return JSON.parse(fs.readFileSync(file || contractPath(), 'utf8'));
}

function constitution(projectRoot, file) {
  const c = readContract(file);
  const data = {};
  for (const [k, v] of Object.entries(c)) if (typeof v === 'string' && !k.startsWith('$')) data[k] = v;
  if (projectRoot) data.projectRoot = projectRoot;
  return render(c.constitution, data, 1, c);
}

function constitutionRuleCount(file) {
  const c = readContract(file);
  return Array.isArray(c.constitution && c.constitution.rules) ? c.constitution.rules.length : 0;
}

module.exports = { constitution, constitutionRuleCount };

if (require.main === module) {
  const arg = process.argv[2];
  process.stdout.write(arg === '--count' ? String(constitutionRuleCount()) : constitution(arg || ''));
}
