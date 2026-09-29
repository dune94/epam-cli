'use strict';
/**
 * THE CODEMIE CLIENT THE codemie-web STACK TALKS THROUGH — one place.
 *
 * A real run uses the CodeMie CLI's OWN authenticated client (its SSO login; the pattern mx-tracker's
 * tools/dc_query.mjs proved), so no credential ever passes through the pipeline. A rehearsal is
 * redirected by the provider set's declared `redirect` (EPAM_CODEMIE_WEB_URL): a plain SDK client
 * pointed at the harness's mock CodeMie, with a stand-in token.
 *
 * The CLI's package is found from the `codemie` binary on PATH (providers.json cliBinary), never from
 * a machine path. EPAM_CODEMIE_CLI_DIR overrides it.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const PACKAGE = '@codemieai/code';

/** The installed CodeMie CLI package directory. */
function cliPackageDir(env = process.env) {
  if (env.EPAM_CODEMIE_CLI_DIR) return env.EPAM_CODEMIE_CLI_DIR;
  let bin;
  try { bin = execFileSync('bash', ['-c', 'command -v codemie'], { encoding: 'utf8' }).trim(); } catch { bin = ''; }
  if (!bin) throw new Error('[codemie-web] the `codemie` CLI is not on PATH — install it (npm i -g @codemieai/code) and sign in');
  let dir = path.dirname(fs.realpathSync(bin));
  for (let i = 0; i < 6 && dir !== path.dirname(dir); i += 1) {
    const pj = path.join(dir, 'package.json');
    try { if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === PACKAGE) return dir; } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  throw new Error(`[codemie-web] could not find the ${PACKAGE} package from ${bin}`);
}

const importFrom = (dir, rel) => import(pathToFileURL(path.join(dir, rel)).href);

/** An authenticated CodeMie SDK client (or the rehearsal's, when redirected). */
async function client(env = process.env) {
  const pkg = cliPackageDir(env);
  if (env.EPAM_CODEMIE_WEB_URL) {
    const { CodeMieClient } = await importFrom(pkg, 'node_modules/codemie-sdk/dist/index.js');
    return new CodeMieClient({ codemie_api_domain: env.EPAM_CODEMIE_WEB_URL, jwt_token: env.EPAM_CODEMIE_WEB_TOKEN || 'rehearsal', verify_ssl: false });
  }
  const { ConfigLoader } = await importFrom(pkg, 'dist/utils/config.js');
  const { getAuthenticatedClient } = await importFrom(pkg, 'dist/utils/auth.js');
  // The CLI prints progress ("Loading configuration...") to stdout; a caller that prints an answer
  // must not have it mixed in, so stdout is held for the duration of the sign-in.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
  try {
    return await getAuthenticatedClient(await ConfigLoader.load(process.cwd()));
  } finally {
    process.stdout.write = write;
  }
}

module.exports = { client, cliPackageDir };
