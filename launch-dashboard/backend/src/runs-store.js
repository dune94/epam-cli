/**
 * runs-store.js — run history, and the one rule that protects the machine.
 *
 * SQLite via node:sqlite (Node 22+). Zero dependencies: this artefact ships to clients, and every
 * dependency is something a client security review has to accept and something the release scanner
 * has to cover.
 *
 * WHY A DATABASE AT ALL. The grid is history — what ran, for which ticket, who asked, how it ended.
 * The pipeline already writes per-run artefacts under orchestrations/projects/<p>/runs/<id>/, but
 * those are the RUN's record of itself. This is the REQUEST's record: it exists from the moment
 * someone presses Save, before any run id exists, and it must survive a restart.
 *
 * WHY "REFUSE WHILE BUSY" LIVES HERE. Two concurrent runs exhausted a 14GB workstation on
 * 2026-09-02 and forced a restart that took the terminal, docker and the session with it. The
 * operator chose reject-over-queue. A check in the UI is advisory the moment someone opens a second
 * tab, and a check in the API is advisory the moment there are two API processes — so it is
 * enforced in the store, against the same rows the grid reads.
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

/**
 * Statuses in which a run still OWNS THE MACHINE.
 *
 * `paused` is deliberately absent. A paused run has EXITED — run-agent-orchestration.sh prints the
 * checkpoint and calls `exit 0` — so the host is free and another run may legitimately start, while
 * this one remains resumable from its checkpoint. Treating paused as busy would block the machine
 * on a run that is not running.
 */
const ACTIVE = ['pending', 'running', 'stopping'];

/**
 * NO ALTER-TABLE CONVENTION EXISTED BEFORE THIS. providerSet was added after the table was
 * already shipping, so a DB created by an earlier version of this app is missing the column.
 * `PRAGMA table_info` + a conditional `ALTER TABLE ADD COLUMN` is the whole migration: nullable
 * at the SQL level (an old row predates this feature and showing it with no recorded set is
 * honest), with "required" enforced at the JS layer in createRun for rows going forward.
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  if (!cols.includes('providerSet')) {
    db.exec('ALTER TABLE runs ADD COLUMN providerSet TEXT');
  }
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id           TEXT PRIMARY KEY,
      ticket       TEXT NOT NULL,
      requestedBy  TEXT NOT NULL,
      status       TEXT NOT NULL,
      stage        TEXT,
      runId        TEXT,
      detail       TEXT,
      pauseAfterMint    INTEGER NOT NULL DEFAULT 0,
      pauseBeforeWriter INTEGER NOT NULL DEFAULT 0,
      resumeOf     TEXT,
      resumeRunId  TEXT,
      replayOf     TEXT,
      codeLevel    TEXT,
      providerSet  TEXT,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_created ON runs (createdAt DESC);
  `);
  migrate(db);
  return db;
}

function close(db) { db.close(); }

function nowIso() { return new Date().toISOString(); }

/** The active run, or null. One row at most — enforced by createRun. */
function activeRun(db) {
  const q = db.prepare(
    `SELECT * FROM runs WHERE status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY createdAt DESC LIMIT 1`,
  );
  return q.get(...ACTIVE) ?? null;
}

/**
 * Record a request. THROWS if the machine is already busy — the caller turns that into a 409 and
 * the UI says why. Nothing is written on rejection: a rejected request is not history, and a grid
 * full of refusals teaches an operator to ignore the grid.
 */
function createRun(db, { ticket, requestedBy, pauseAfterMint = false, pauseBeforeWriter = false,
                        resumeOf = null, resumeRunId = null, replayOf = null,
                        codeLevel = null, detail = null, providerSet = null }) {
  if (!ticket || !String(ticket).trim()) throw new Error('a run needs a ticket id');
  if (!requestedBy || !String(requestedBy).trim()) throw new Error('a run needs a requester');
  // NO VENDOR DEFAULT, EVER — matching config.js/runner-args.js. A guessed provider is how
  // MiniMax reached a claude run. Refuse rather than launch on the operator's behalf.
  if (!providerSet || !String(providerSet).trim()) {
    throw new Error('a run needs a provider set — refusing to guess a vendor');
  }

  const busy = activeRun(db);
  if (busy) {
    const e = new Error(
      `busy: ${busy.ticket} is already ${busy.status} (started ${busy.createdAt}). `
      + 'One run at a time — two concurrent runs exhaust the host.',
    );
    e.code = 'BUSY';
    e.activeRun = busy;
    throw e;
  }

  const row = {
    id: crypto.randomUUID(),
    ticket: String(ticket).trim(),
    requestedBy: String(requestedBy).trim(),
    status: 'pending',
    stage: null,
    runId: null,
    detail,
    pauseAfterMint: pauseAfterMint ? 1 : 0,
    pauseBeforeWriter: pauseBeforeWriter ? 1 : 0,
    resumeOf,
    resumeRunId,
    replayOf,
    codeLevel,
    providerSet: String(providerSet).trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.prepare(`INSERT INTO runs
      (id,ticket,requestedBy,status,stage,runId,detail,pauseAfterMint,pauseBeforeWriter,
       resumeOf,resumeRunId,replayOf,codeLevel,providerSet,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.ticket, row.requestedBy, row.status, row.stage, row.runId, row.detail,
         row.pauseAfterMint, row.pauseBeforeWriter, row.resumeOf, row.resumeRunId,
         row.replayOf, row.codeLevel, row.providerSet, row.createdAt, row.updatedAt);
  return row;
}

/**
 * Progress from the host-side runner. `updatedAt` is a HEARTBEAT, not decoration: without it a
 * stalled run and a working one look identical in the grid, which is the silent-failure shape this
 * project has spent two days removing. A reader compares it against now and decides.
 */
function updateProgress(db, id, { stage, runId, status, detail, codeLevel } = {}) {
  const cur = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  if (!cur) throw new Error(`no such run: ${id}`);
  db.prepare('UPDATE runs SET stage=?, runId=?, status=?, detail=?, codeLevel=?, updatedAt=? WHERE id=?')
    .run(stage ?? cur.stage, runId ?? cur.runId, status ?? cur.status,
         detail ?? cur.detail, codeLevel ?? cur.codeLevel, nowIso(), id);
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

/** Terminal state. Anything not in ACTIVE frees the machine for the next request. */
function finishRun(db, id, status, detail) {
  if (ACTIVE.includes(status)) throw new Error(`${status} is not a terminal status`);
  return updateProgress(db, id, { status, detail });
}

/**
 * Continue a paused run. Creates a NEW row rather than mutating the paused one: history must show
 * both the pause and the answer to it, or the record of a human being asked disappears.
 *
 * `resumeRunId` becomes EPAM_RESUME_RUN. Refusing when it is absent is not pedantry — a launch
 * WITHOUT it starts a FRESH run, and on a brownfield defect a fresh run resets the codeline to
 * baseline and discards committed work. That happened live on 2026-09-02 and cost the run.
 */
/**
 * `providerSet` is OPTIONAL here, unlike createRun: absent means "continue with the same set this
 * run already declared" — not a guess, a carry-forward of a choice already made. Given, it is a
 * SWAP, validated against the resume-safe subset only: mockserver (the no-pay rehearsal set) is
 * never offered as a live-run swap target, so an operator cannot land a real run on the mock
 * endpoint by mistake.
 */
function resumeRun(db, id, { requestedBy, providerSet = null }) {
  const paused = getRun(db, id);
  if (!paused) throw new Error(`no such run: ${id}`);
  if (paused.status !== 'paused') {
    throw new Error(`run ${id} is ${paused.status}, not paused — nothing to resume`);
  }
  if (!paused.runId) {
    throw new Error(
      `run ${id} is paused but recorded no pipeline runId — cannot resume. Resuming without `
      + 'EPAM_RESUME_RUN would start a FRESH run and reset the codeline.',
    );
  }
  const nextProviderSet = providerSet ? String(providerSet).trim() : paused.providerSet;
  if (providerSet && String(providerSet).trim() === 'mockserver') {
    throw new Error(
      'cannot resume into mockserver — the no-pay rehearsal set is never a live-run swap target',
    );
  }
  return createRun(db, {
    ticket: paused.ticket,
    requestedBy,
    pauseAfterMint: !!paused.pauseAfterMint,
    pauseBeforeWriter: !!paused.pauseBeforeWriter,
    resumeOf: paused.id,
    resumeRunId: paused.runId,
    providerSet: nextProviderSet,
  });
}

/**
 * Run it again with the SAME inputs. A replay is a FRESH run, never a resume: a resume continues a
 * checkpoint, a replay reproduces from the start. Carrying resumeRunId into a replay would silently
 * continue the original instead of reproducing it.
 *
 * THE CODE LEVEL IS AN INPUT. A replay against different pipeline code is not a replay, it is a new
 * experiment wearing the same name — so the original level is carried over, and if the installed
 * pipeline has since moved, that is RECORDED on the replay rather than discovered in the diff.
 * Operator, 2026-09-02: "no manipulations, otherwise it is not repeatable and replayable."
 *
 * A FAILED run is replayable too: reproducing a failure is the entire point of a bug report.
 */
function replayRun(db, id, { requestedBy, currentCodeLevel = null }) {
  const orig = getRun(db, id);
  if (!orig) throw new Error(`no such run: ${id}`);
  if (ACTIVE.includes(orig.status) || orig.status === 'paused') {
    throw new Error(`run ${id} is ${orig.status} — only a finished run can be replayed`);
  }

  let detail = null;
  if (currentCodeLevel && orig.codeLevel && currentCodeLevel !== orig.codeLevel) {
    detail = `code level moved since the original: ${orig.codeLevel} -> ${currentCodeLevel}. `
      + `This replay targets ${orig.codeLevel}.`;
  }

  return createRun(db, {
    ticket: orig.ticket,
    requestedBy,
    pauseAfterMint: !!orig.pauseAfterMint,
    pauseBeforeWriter: !!orig.pauseBeforeWriter,
    replayOf: orig.id,
    codeLevel: orig.codeLevel,
    // NO OVERRIDE ACCEPTED, unlike resume. "no manipulations, otherwise it is not repeatable and
    // replayable" (operator, 2026-09-02) — a replay reproduces the original exactly.
    providerSet: orig.providerSet,
    detail,
  });
}

/** Newest first: the grid shows the current run at the top. */
function listRuns(db, limit = 200) {
  return db.prepare('SELECT * FROM runs ORDER BY createdAt DESC LIMIT ?').all(limit);
}

function getRun(db, id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) ?? null;
}

export {
  open, close, createRun, resumeRun, replayRun, updateProgress, finishRun, listRuns, getRun, activeRun, ACTIVE,
};
