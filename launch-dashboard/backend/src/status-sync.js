/**
 * status-sync.js — the DB's view of a run is only ever as fresh as the last time something
 * copied the host-side runner's real status into it. Nothing ever did.
 *
 * runner.js writes progress and terminal status to spool/status/<id>.json — the ONLY channel from
 * the host back to the container (see spool.js's header: the container gets no host privileges, so
 * a directory is the whole contract). GET /api/runs and GET /api/runs/:id read ONLY the DB. Nothing
 * bridged the two, so a row stayed exactly as createRun() first wrote it — 'pending' — for the rest
 * of its life, no matter what the run actually did.
 *
 * What that looked like, live 2026-09-04: a run that had ALREADY failed at pre-flight showed
 * "pending" in the dashboard indefinitely, and because the busy-check reads the same table, it also
 * blocked every new save behind a run that had been dead for hours — the only way out was deleting
 * the row by hand with node:sqlite. Operator, watching a run that was minutes into real work:
 * "no updates at all pending and no info for user - very useless."
 *
 * SCOPED TO ACTIVE ROWS. A terminal row never changes again, so there is nothing to sync for one —
 * and re-reading a status file for every historical row on every poll would be needless I/O for a
 * grid that holds hundreds. It is also what makes a stale status file harmless: once a row has
 * closed, no later file can reopen it.
 */
import * as store from './runs-store.js';
import * as spool from './spool.js';

/**
 * Copy the runner's own status into the DB for every run still considered active.
 *
 * Never invents a status: a run with no status file yet (the runner has not picked it up) is left
 * exactly as the DB has it. Absent and unreadable both mean "I do not know", which is spool.js's
 * own contract for readStatus().
 */
function syncActiveRunsFromSpool(db, spoolDir) {
  if (!db || !spoolDir) return;
  for (const row of store.listRuns(db)) {
    if (!store.ACTIVE.includes(row.status)) continue;
    let s = null;
    try { s = spool.readStatus(spoolDir, row.id); } catch { s = null; }
    if (!s || !s.status || s.status === row.status) continue;
    // updateProgress carries stage/runId/detail through unchanged when the status file omits them
    // (it coalesces against the current row), so a progress update never blanks what a previous
    // one recorded. The runId matters most: without it a paused or failed run can never be
    // resumed, and a resume without EPAM_RESUME_RUN starts a FRESH run that resets the codeline.
    try {
      store.updateProgress(db, row.id, {
        stage: s.stage, runId: s.runId, status: s.status, detail: s.detail,
      });
    } catch { /* the row vanished under us — nothing to sync */ }
  }
}

export { syncActiveRunsFromSpool };
