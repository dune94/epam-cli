#!/usr/bin/env node
// Lightweight replacement for the Eleventy watcher when it OOMs.
// Calls snapshot.js:loadSnapshot() every INTERVAL seconds and writes the
// result to dashboards/live/build-info.json atomically. Runs until killed.
//
// Usage: node snapshot-watch.js [interval_seconds]  (default 10)

'use strict';
const path = require('path');
const fs   = require('fs');

const REPO_ROOT    = path.join(__dirname, '../..');
const DASH_DIR     = path.join(REPO_ROOT, 'orchestrations/dashboards');
const OUT_FILE     = path.join(DASH_DIR, 'live/build-info.json');
const INTERVAL_MS  = (parseInt(process.argv[2], 10) || 10) * 1000;

const { loadSnapshot } = require(path.join(DASH_DIR, 'build/snapshot'));

function rebuild() {
  try {
    const snap = loadSnapshot();
    const json = JSON.stringify(snap, null, 2);
    const tmp  = OUT_FILE + '.tmp';
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, OUT_FILE);
    process.stdout.write(`[snapshot-watch] rebuilt at ${new Date().toISOString()} (analystCycles=${snap.metrics?.selfHealing?.healing?.analystCycles ?? '?'})\n`);
  } catch (err) {
    process.stderr.write(`[snapshot-watch] error: ${err.message}\n`);
  }
}

rebuild();
const timer = setInterval(rebuild, INTERVAL_MS); // ref'd — keeps event loop alive

process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('SIGINT',  () => { clearInterval(timer); process.exit(0); });

process.stdout.write(`[snapshot-watch] polling every ${INTERVAL_MS / 1000}s → ${OUT_FILE}\n`);
