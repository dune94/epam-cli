#!/usr/bin/env node
/**
 * RESOLVE A SYMBOL IN A PACKAGE, VIA THE PLUGIN THAT KNOWS HOW.
 *
 * Loads the resolve_package_symbol tool out of a plugin and runs it against one package and one
 * symbol, from inside the repo being asked about.
 *
 * Lifted out of resolve-package-symbol.sh on 2026-08-16, where it was a `node -e "..."` string.
 * Its inputs already arrived as environment variables, which is why nothing was interpolated into
 * its source — that made it the safest of the inline programs, and it is still better as a file.
 *
 * Generic: the repo, the plugin and the query are all supplied by the caller.
 *
 *   RPS_REPO     the repository to resolve from
 *   RPS_PLUGIN   the plugin providing resolve_package_symbol
 *   RPS_PACKAGE  the package
 *   RPS_SYMBOL   the symbol
 *   exit 0       resolved;  exit 1  the tool reported an error
 *
 * A missing variable now says which one, rather than throwing a stack trace at the caller.
 */
'use strict';

for (const v of ['RPS_REPO', 'RPS_PLUGIN', 'RPS_PACKAGE', 'RPS_SYMBOL']) {
  if (!process.env[v]) {
    process.stderr.write(`[package-symbol-resolve] ${v} is not set\n`);
    process.exit(2);
  }
}

process.chdir(process.env.RPS_REPO);
const { tools } = require(process.env.RPS_PLUGIN);
const tool = tools.find((t) => t.name === 'resolve_package_symbol');
tool.execute({ packageName: process.env.RPS_PACKAGE, symbol: process.env.RPS_SYMBOL }).then((result) => {
  console.log(result.content);
  process.exit(result.isError ? 1 : 0);
});

