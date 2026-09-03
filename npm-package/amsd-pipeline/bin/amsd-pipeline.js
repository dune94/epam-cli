#!/usr/bin/env node
'use strict';

// THIS FILE IS DELIBERATELY THIN. Every real decision — self-clone, packaging, docker isolation,
// uninstall — lives in install.sh, sourced from orchestrations-installer/install.sh at publish
// time (see ../sync-install-sh.sh) and never duplicated here. `npx amsd-pipeline` exists only to
// get a user from "no git commands" to "the same install.sh a colleague running from a checkout
// would run" with zero divergence between the two paths.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const installScript = path.join(__dirname, '..', 'install.sh');
const result = spawnSync('bash', [installScript, ...process.argv.slice(2)], { stdio: 'inherit' });

if (result.error) {
  // bash itself could not be found/spawned — a clear message beats a raw ENOENT stack.
  process.stderr.write(`amsd-pipeline: could not run bash (${result.error.message})\n`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
