#!/usr/bin/env node
/**
 * server.js — the API process. Runs in a container; starts no pipeline itself.
 *
 * It writes requests into the spool; the host-side runner (src/runner-host.js) is the only thing
 * that launches. See launch-dashboard/README.md for why the boundary is a directory.
 */
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { listProviderSets } from './provider-sets.js';

const cfg = loadConfig();

// FAIL AT STARTUP, not at the first click of the launch form. listProviderSets() throws if the
// orchestrations/config mount is missing or the file it reads is unreadable/malformed — better to
// know that before anyone reaches for the picker.
const providerSets = listProviderSets();

const server = createApp(cfg);

server.listen(cfg.port, cfg.host, () => {
  // Say what was configured. An operator reading this line must not have to infer the mode.
  console.log(`[launch-api] listening on ${cfg.host}:${cfg.port}`);
  console.log(`[launch-api] db=${cfg.dbFile} spool=${cfg.spoolDir} `
    + `providerSets=${providerSets.map((s) => s.name).join(',')} codeLevel=${cfg.codeLevel ?? '<unset>'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
