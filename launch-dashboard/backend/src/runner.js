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

/**
 * WHAT IS THE PIPELINE DOING RIGHT NOW — read from what the pipeline already publishes.
 *
 * The pipeline maintains step-status.json and rewrites it as it advances: every step with
 * pass/fail/skip/running, and a detail line that carries the model. Nothing read it, so the launch
 * dashboard showed "running — starting" for the whole of a two-and-a-half hour run and then
 * "no update in 10m" — on a healthy run. Operator, 2026-09-04: "dashboard not useful at all."
 *
 * NOTHING IS HARDCODED. No step list, no step name, no phase: the current step is whichever one
 * the pipeline itself marks `running`, and the label shown is the pipeline's own. A step added
 * tomorrow appears tomorrow.
 *
 * Returns null when there is nothing to say — a missing file, a half-written one (this file is
 * rewritten constantly, so a poll WILL eventually catch one mid-write), or no step in flight.
 * Observability must never fail the run it observes.
 */
function readCurrentStage(progressFile) {
  if (!progressFile) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch { return null; }
  const steps = Array.isArray(doc?.steps) ? doc.steps : [];
  if (!steps.length) return null;

  // The step in flight. Failing that, the furthest one that has actually been reached — after the
  // last step completes there is a real gap before the run ends, and "the last thing that
  // happened" is far more use than silence.
  const running = steps.find((s) => s && s.status === 'running');
  const reached = [...steps].reverse().find((s) => s && s.status && s.status !== 'pending');
  const step = running || reached;
  if (!step || !step.label) return null;

  const label = String(step.label).trim();
  const detail = String(step.detail || '').trim();
  return detail ? `${label} · ${detail}` : label;
}

function createRunner({ spoolDir, launcher, dry = false, pollMs = 1000,
                       // Where the pipeline publishes its own progress, and how often to look.
                       // Absent means the runner simply reports nothing extra — it never invents.
                       progressFile = process.env.EPAM_STEP_STATUS_FILE || null,
                       progressMs = 5000,
                       // Default FALSE: the only production caller is a daemon whose sole job is this
                       // timer. An embedding caller that must not have its event loop held open can
                       // opt in, but that is the unusual case and it should have to say so.
                       unrefPoll = false }) {
  // NO SERVER-WIDE providerSet ANYMORE. It used to be fixed once at startup for every launch this
  // runner would ever make; now every REQUEST declares its own (enforced by spool.writeRequest),
  // and tick() reads it per-request below. A vendor is still never guessed — a request that
  // somehow has none fails LOUDLY, per-request, rather than the whole runner refusing to exist.
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

      // THE REQUEST'S OWN SET, not a fixed server default. spool.writeRequest() already refuses
      // to write one without a providerSet — this check is the defensive fallback for a request
      // that reached the spool file some other way (e.g. left over from before this field
      // existed). Failing THIS ONE request, rather than throwing out of tick() and stalling every
      // future request behind it, is deliberate: one bad file must not take the runner down.
      if (!req.providerSet || !String(req.providerSet).trim()) {
        writeStatus(spoolDir, id, {
          status: 'failed',
          detail: 'no provider set on this request — refusing to guess a vendor',
        });
        return { id, failed: true };
      }
      const providerSet = req.providerSet;
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

      // FOLLOW THE RUN WHILE IT RUNS. Started before the launcher and cleared in a finally below,
      // so it cannot outlive the run and overwrite its outcome with "running" — a finished run
      // that looks live forever would be worse than no progress at all.
      let lastStage = 'starting';
      const progress = setInterval(() => {
        try {
          const stage = readCurrentStage(progressFile);
          if (!stage || stage === lastStage) return;
          lastStage = stage;
          writeStatus(spoolDir, id, { status: 'running', stage });
        } catch { /* observability never fails the run it observes */ }
      }, progressMs);

      let result;
      try {
        result = await launcher(req, env, argv, { waitForStop: () => waitForStop(id), stopRequested: () => stopRequested(id) });
      } catch (e) {
        // A launch that throws must not leave a row pending forever — pending that never advances
        // is indistinguishable from working, which is the silent-failure shape this project keeps
        // hitting.
        writeStatus(spoolDir, id, { status: 'failed', detail: String(e && e.message ? e.message : e) });
        return { id, failed: true };
      } finally {
        clearInterval(progress);
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
