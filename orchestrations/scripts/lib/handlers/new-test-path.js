#!/usr/bin/env node
/**
 * new-test-path.js — WHERE DOES A NEW TEST FOR THIS SOURCE GO, asked of the plugin.
 *
 * The engine may hold no stack convention of its own. brownfield-repro-test-writer.sh used to
 * decide with literals (`_ext="spec.ts"`), which hardcoded stack filenames into engine code and
 * collapsed .ts/.tsx into one — so a .tsx React component was handed a .spec.ts target and the
 * stage then reported "no valid test" about a file the agent had written correctly.
 *
 *   node new-test-path.js <projectRoot> <sourceFile>
 *
 * stdout  TARGET=<path>\nEXAMPLE=<path or empty>
 * exit 0  answered
 * exit 1  the plugin could not answer — the caller must FAIL, never guess a convention
 */
'use strict';
const path = require('path');

function main() {
  const [root, source] = process.argv.slice(2);
  if (!root || !source) {
    process.stderr.write('[new-test-path] usage: <projectRoot> <sourceFile>\n');
    return 2;
  }
  let plugin;
  try {
    plugin = require(path.join(__dirname, '..', '..', '..', 'plugins', 'codeline-context-plugin.js'));
  } catch (e) {
    process.stderr.write(`[new-test-path] codeline-context-plugin unavailable: ${e.message}\n`);
    return 1;
  }
  if (typeof plugin.newTestPath !== 'function') {
    process.stderr.write('[new-test-path] the plugin does not expose newTestPath\n');
    return 1;
  }
  const target = plugin.newTestPath(root, source);
  if (!target) {
    process.stderr.write(`[new-test-path] the plugin returned no path for ${source}\n`);
    return 1;
  }
  const example = typeof plugin.exampleTestFile === 'function' ? plugin.exampleTestFile(root, source) : '';
  process.stdout.write(`TARGET=${target}\nEXAMPLE=${example || ''}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
