/**
 * runner.js — the host-side watcher. THE ONLY THING THAT STARTS A PIPELINE.
 *
 * It runs on the host, not in a container, because the pipeline runs on the host. It watches the
 * spool directory the containerised API writes into, so the container never needs host privileges,
 * a docker socket, or an ssh key. The trust boundary is one directory.
 *
 * IT OWNS THE LOCK. "Reject while busy" is enforced in the store for the UI, but the runner is the
 * only component that knows a launch is genuinely in flight, so it refuses too. Two concurrent runs
 * exhausted a 14GB workstation on 2026-09-02 and forced a restart that took the terminal, docker
 * and the session with it.
 *
 * THE LAUNCHER IS INJECTED. Tests supply a stub: a paid run is not a unit test. A real `--dry` mode
 * exists for the same reason, so every path can be walked on a host without spending anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as spool from './spool.js';
import { buildLaunchEnv, buildLaunchArgv } from './runner-args.js';

const REQUESTS = 'requests';

function writeStatus(dir, id, body) {
  const target = path.join(dir, 'status', `${id}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ id, ...body, at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

function createRunner({ spoolDir, providerSet, launcher, dry = false, pollMs = 1000,
                       // Default FALSE: the only production caller is a daemon whose sole job is this
                       // timer. An embedding caller that must not have its event loop held open can
                       // opt in, but that is the unusual case and it should have to say so.
                       unrefPoll = false }) {
  // NO VENDOR DEFAULT. A guessed provider is how MiniMax reached a claude run.
  if (!providerSet || !String(providerSet).trim()) {
    throw new Error('the runner needs a provider set — refusing to guess a vendor');
  }
  if (typeof launcher !== 'function') throw new Error('the runner needs a launcher');

  spool.init(spoolDir);
  let busy = false;                       // the lock: one launch at a time, on this host
  const claimed = new Set();              // requests already taken, so a poll never double-launches

  const stopRequested = (id) => fs.existsSync(path.join(spoolDir, REQUESTS, `${id}.stop`));

  /**
   * Resolve when a stop marker appears for this run. The launcher decides what to do about it.
   *
   * NOT unref'd, unlike the poll timer below: an unref'd timer does not hold the event loop open,
   * so the promise would never resolve and a stop would hang instead of stopping.
   */
  const waitForStop = (id) => new Promise((resolve) => {
    const iv = setInterval(() => {
      if (stopRequested(id)) { clearInterval(iv); resolve(true); }
    }, 25);
  });

  function pending() {
    let names = [];
    try { names = fs.readdirSync(path.join(spoolDir, REQUESTS)); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, ''))
      .filter((id) => !claimed.has(id))
      .sort();                            // oldest id first; ids are stable so this is deterministic
  }

  async function tick() {
    if (busy) return null;                // the lock, checked before anything is claimed
    const [id] = pending();
    if (!id) return null;

    busy = true;
    claimed.add(id);
    try {
      let req;
      try {
        req = JSON.parse(fs.readFileSync(path.join(spoolDir, REQUESTS, `${id}.json`), 'utf8'));
      } catch (e) {
        // A malformed request is a FAILURE, never silently skipped: someone pressed Save and is
        // waiting for an answer.
        writeStatus(spoolDir, id, { status: 'failed', detail: `unreadable request: ${e.message}` });
        return null;
      }

      const env = buildLaunchEnv(req, { providerSet });
      const argv = buildLaunchArgv(req, { providerSet });

      if (dry) {
        // Walks every path above and launches nothing. The detail names what WOULD have run, so a
        // dry run is evidence rather than a reassurance.
        writeStatus(spoolDir, id, {
          status: 'dry-run',
          detail: `would launch with ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} `
                + `argv=${argv.join(' ')}`,
        });
        return { id, dry: true };
      }

      writeStatus(spoolDir, id, { status: 'running', stage: 'starting' });

      let result;
      try {
        result = await launcher(req, env, argv, { waitForStop: () => waitForStop(id), stopRequested: () => stopRequested(id) });
      } catch (e) {
        // A launch that throws must not leave a row pending forever — pending that never advances
        // is indistinguishable from working, which is the silent-failure shape this project keeps
        // hitting.
        writeStatus(spoolDir, id, { status: 'failed', detail: String(e && e.message ? e.message : e) });
        return { id, failed: true };
      }

      const { code = 0, runId = null, paused = false, stopped = false } = result ?? {};
      // ORDER MATTERS: stopped and paused are both non-failures that can carry a non-zero code.
      const status = stopped ? 'stopped'
        : paused ? 'paused'
        : code === 0 ? 'succeeded'
        : 'failed';

      // The runId is carried even on failure: without it a paused or partial run can never be
      // resumed, and a resume without EPAM_RESUME_RUN starts a FRESH run that resets the codeline.
      writeStatus(spoolDir, id, { status, runId, detail: `exit ${code}` });
      return { id, status, runId };
    } finally {
      busy = false;
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
    // NOT UNREF'D. This timer is the only thing holding runner-host.js open, so unref'ing it told
    // node the process was free to exit — and it did, instantly, having just printed "watching".
    // A run created in the UI then sat at "pending" forever with no error anywhere.
    //
    // unref() belongs on a timer that is incidental to a process doing other work. Here the timer
    // IS the work. A caller that embeds the runner and wants it not to hold its own loop open can
    // ask, but a daemon must never be given that by default.
    if (unrefPoll) timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, start, stop, isBusy: () => busy };
}

export { createRunner };
