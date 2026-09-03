#!/usr/bin/env node
/**
 * runner-host.js — the watcher that runs ON THE HOST, next to the pipeline.
 *
 * Not in a container: a container cannot exec a host process. It polls the spool the API writes
 * into, launches the pipeline's own launcher, and writes status back. It owns the lock, because it
 * is the only component that knows a launch is genuinely in flight.
 *
 *   node runner-host.js [--dry]
 *
 * --dry walks every path and launches nothing, writing a status that names what it WOULD have run.
 * Use it to prove an install before spending anything.
 */
import path from 'node:path';
import { loadConfig } from './config.js';
import { createRunner } from './runner.js';
import { createLauncher } from './launcher.js';

const dry = process.argv.includes('--dry');
const cfg = loadConfig();

// The pipeline's own launcher. Declared, never discovered: guessing which script starts a paid run
// is not a decision this component should make.
const script = process.env.EPAM_LAUNCHER
  ?? path.join(process.env.EPAM_HOME ?? process.cwd(), 'orchestrations/scripts/tier3-metrolinx-run.sh');
const cwd = process.env.EPAM_HOME ?? process.cwd();

const launcher = createLauncher({
  script,
  cwd,
  // Memory is bounded at the launch, not hoped for. A client install must not kill the machine:
  // an unbounded run exhausted a 14GB workstation on 2026-09-02. NODE_OPTIONS is the portable
  // floor — it works with no systemd user bus, which cannot be assumed on a client box.
  extraEnv: {
    NODE_OPTIONS: process.env.EPAM_NODE_OPTIONS ?? '--max-old-space-size=4096',
  },
  onOutput: (line) => process.stdout.write(`[pipeline] ${line}\n`),
});

const runner = createRunner({
  spoolDir: cfg.spoolDir,
  providerSet: cfg.providerSet,
  launcher,
  dry,
});

console.log(`[launch-runner] watching ${cfg.spoolDir}${dry ? ' (DRY — nothing will be launched)' : ''}`);
console.log(`[launch-runner] launcher=${script}`);
runner.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { runner.stop(); process.exit(0); });
}
