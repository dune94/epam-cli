#!/usr/bin/env node
/**
 * HARVEST THE RECORDING WITHOUT ASKING THE RUN.
 *
 * The EXIT trap in run-agent-orchestration.sh covers every exit bash controls — completion, the
 * pause, every failure. It cannot cover `kill -9` or an OOM kill, and those are exactly how this
 * project lost recordings: a run killed by hand, and WSL reclaiming memory mid-run.
 *
 * Langfuse records each call as it happens, so a dying run's turns are already durable ON THE
 * SERVER. Nothing needs to be salvaged from the process — it only needs to be fetched by something
 * that is still alive. That is this: a sweep owned by the INSTALL, started and stopped the way
 * snapshot-watch is, so a run cannot take it down with it.
 *
 * What it writes is a PARTIAL cassette — `session-<id>.partial` — refreshed while the recording
 * grows. It is deliberately not named like a finished one: a cassette the run archived is run
 * evidence and is never rewritten ([[fb_never_rewrite_run_evidence]]), so the moment the run's own
 * cassette appears for a session, this stands down and removes its partial.
 *
 * Usage:  cassette-watch.js [intervalSeconds]
 * Env:    EPAM_CASSETTE_DIR       where cassettes live (required)
 *         EPAM_CASSETTE_EXPORTER  the exporter; defaults to cassette-export.js beside this file
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_EXPORTER = path.join(__dirname, 'cassette-export.js');

/** The sessions Langfuse currently holds, newest-first as the exporter lists them. */
function listSessions(node, exporter) {
  const r = spawnSync(node, [exporter, '--list'], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) return [];
  return (r.stdout || '')
    .split('\n')
    .map((l) => l.split('\t')[0].trim())
    .filter(Boolean);
}

/**
 * A session is finished when a cassette the RUN wrote exists for it. That name is
 * `<project>-<session>`, and the project is not knowable here, so it is matched by suffix — any
 * directory ending in the session id that is not this watcher's own partial.
 */
function finalCassetteFor(cassetteDir, session) {
  let entries;
  try { entries = fs.readdirSync(cassetteDir); } catch { return null; }
  const partial = partialName(session);
  return entries.find((e) => e !== partial && e.endsWith(session)) || null;
}

const partialName = (session) => `session-${session}.partial`;

/**
 * ONE SWEEP. Staged then swapped, never written in place: a failed or interrupted export must not
 * leave something that reads as a cassette — a replayer would accept it and diverge, which is worse
 * than having nothing. One session's failure never ends the sweep.
 */
function harvestOnce({ cassetteDir, exporter, node }) {
  const _node = node || process.execPath;
  const _exporter = exporter || DEFAULT_EXPORTER;
  const harvested = [];
  const skipped = [];
  const failed = [];

  for (const session of listSessions(_node, _exporter)) {
    const dest = path.join(cassetteDir, partialName(session));

    // The run archived it: stand down, and take the superseded partial with us.
    if (finalCassetteFor(cassetteDir, session)) {
      fs.rmSync(dest, { recursive: true, force: true });
      skipped.push(session);
      continue;
    }

    const staging = `${dest}.staging-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    const r = spawnSync(_node, [_exporter, '--session', session, '--out', staging],
      { encoding: 'utf8', timeout: 600_000 });

    if (r.status !== 0 || !fs.existsSync(path.join(staging, 'manifest.json'))) {
      fs.rmSync(staging, { recursive: true, force: true });
      failed.push(session);
      continue;
    }

    // REPLACE, because a partial is not evidence — it is the best copy so far, and a longer
    // recording supersedes a shorter one.
    fs.rmSync(dest, { recursive: true, force: true });
    try {
      fs.renameSync(staging, dest);
      harvested.push(session);
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      failed.push(session);
    }
  }

  // Only after a sweep, and only if it produced something: an empty cassette directory is the
  // honest state when nothing could be harvested.
  return { harvested, skipped, failed };
}

module.exports = { harvestOnce };

if (require.main === module) {
  const intervalMs = (parseInt(process.argv[2], 10) || 60) * 1000;
  const cassetteDir = process.env.EPAM_CASSETTE_DIR;
  const exporter = process.env.EPAM_CASSETTE_EXPORTER || DEFAULT_EXPORTER;
  if (!cassetteDir) {
    process.stderr.write('[cassette-watch] EPAM_CASSETTE_DIR is required — refusing to guess where cassettes live\n');
    process.exit(1);
  }
  const sweep = () => {
    try {
      const r = harvestOnce({ cassetteDir, exporter, node: process.execPath });
      if (r.harvested.length || r.failed.length) {
        process.stdout.write(`[cassette-watch] harvested ${r.harvested.length}, `
          + `superseded ${r.skipped.length}, failed ${r.failed.length}\n`);
      }
    } catch (e) {
      // A sweep that throws must not end the watcher — the next run still needs it alive.
      process.stderr.write(`[cassette-watch] sweep failed: ${e && e.message}\n`);
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.write(`[cassette-watch] sweeping every ${intervalMs / 1000}s → ${cassetteDir}\n`);
}
