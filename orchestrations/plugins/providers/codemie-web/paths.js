'use strict';
/** Where the codemie-web stack keeps its state — one definition, read by the runner and the registry. */
const fs = require('fs');
const path = require('path');

const INSTALL_ROOT = path.join(__dirname, '..', '..', '..', '..');

/** The install's codemie-web home (keys 0600, assistant ids, plugin state and logs); EPAM_CODEMIE_WEB_HOME overrides. */
function home(env = process.env, { create = true } = {}) {
  const h = env.EPAM_CODEMIE_WEB_HOME || path.join(INSTALL_ROOT, '.codemie-web');
  if (create) fs.mkdirSync(h, { recursive: true, mode: 0o700 });
  return h;
}

module.exports = { INSTALL_ROOT, home };
