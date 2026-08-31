#!/usr/bin/env node
/**
 * HOW MUCH OF WHAT THIS STAGE RUNS IS COVERED BY TESTS.
 *
 * The pipeline spends money. The costliest failures this year were not vendor errors — they were
 * untested branches reached at runtime: a seam check shipped at v1.5 that no test ever executed,
 * which killed a metrolinx run at the roster step after paying for ingest, discovery, the estate
 * survey and the mint.
 *
 * Knowing that afterwards is worth little. This is asked BEFORE a stage runs: what proportion of
 * the code this stage executes has a test behind it? Below the declared threshold with the blocker
 * on, the stage does not run and the pipeline halts.
 *
 * ALL CODE IS IN PLAY. Every file belongs to exactly one stage, and `--audit` proves it: the stage
 * line totals must equal the project line total, with nothing unassigned. A denominator chosen by
 * whoever wrote the gate is a denominator that can be flattered.
 *
 * TWO FILES, BECAUSE THEY ANSWER TO DIFFERENT PEOPLE. The stage map is a fact about the ENGINE —
 * which files a stage runs — and lives with the engine. The threshold and the blocker are a fact
 * about a PROJECT: how much cover metrolinx demands before it will spend is not a decision about
 * mock3, and neither is hardcoded here.
 *
 * A project that declares NEITHER is refused rather than defaulted. Inventing 95 would be the
 * engine deciding an operator's risk for them, quietly.
 *
 *   stage-coverage.js <stage>    -> the percentage on stdout, or a refusal
 *   stage-coverage.js --audit    -> {projectLines, stageLines, unassigned[]} for the completeness test
 *   stage-coverage.js --policy   -> {thresholdPercent, blocker} as the PROJECT declares them
 */
'use strict';

const fs = require('fs');
const path = require('path');

// The root the stage map is resolved against. Overridable so this handler can be driven against a
// fixture tree — without it the only way to test the gate is to change the repository it is
// measuring, and a gate that cannot be tested is the thing it exists to prevent.
const REPO = process.env.STAGE_COVERAGE_ROOT || path.resolve(__dirname, '..', '..', '..', '..');
const CONFIG = process.env.STAGE_COVERAGE_CONFIG
  || path.join(REPO, 'orchestrations/config/stage-coverage.json');
const LCOV = process.env.STAGE_COVERAGE_LCOV || path.join(REPO, 'coverage/lcov.info');

/**
 * THE PROJECT'S OWN POLICY. Read from the project config dir, never from the engine — the same
 * place every other per-project decision lives. A project that declares no policy gets a refusal,
 * not a number somebody chose on its behalf.
 */
function policy() {
  const dir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
  const explicit = process.env.STAGE_COVERAGE_POLICY || '';
  const file = explicit || (dir ? path.join(dir, 'coverage-policy.json') : '');
  if (!file) {
    die('no project config dir is set, so no coverage policy can be read. The threshold and the '
      + 'blocker belong to the PROJECT — set EPAM_PROJECT_CONFIG_DIR.');
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch {
    die(`this project declares no coverage policy at ${file}. It must state thresholdPercent and `
      + 'blocker: how much cover a project demands before it spends is the operator\'s decision, '
      + 'and defaulting it here would make that decision silently.');
  }
  let p;
  try { p = JSON.parse(raw); }
  catch (e) { die(`the coverage policy at ${file} is not valid JSON: ${(e && e.message) || e}`); }
  if (typeof p.thresholdPercent !== 'number') {
    die(`the coverage policy at ${file} declares no numeric thresholdPercent`);
  }
  if (typeof p.blocker !== 'boolean') {
    die(`the coverage policy at ${file} declares no boolean blocker — on or off has to be stated`);
  }
  return p;
}

function die(msg, code) {
  process.stderr.write(`[stage-coverage] ${msg}\n`);
  process.exit(code === undefined ? 2 : code);
}

function config() {
  let raw;
  try { raw = fs.readFileSync(CONFIG, 'utf8'); }
  catch (e) { die(`no stage map at ${CONFIG}: ${(e && e.message) || e}`); }
  try { return JSON.parse(raw); }
  catch (e) { die(`the stage map at ${CONFIG} is not valid JSON: ${(e && e.message) || e}`); }
  return null;
}

/** Lines executable and hit, per file, from lcov. Absent data is ABSENT — never zero, never full. */
function lcovByFile() {
  let text;
  try { text = fs.readFileSync(LCOV, 'utf8'); } catch { return null; }
  const out = new Map();
  let file = null; let found = 0; let hit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) { file = line.slice(3).trim(); found = 0; hit = 0; }
    else if (line.startsWith('LF:')) found = Number(line.slice(3)) || 0;
    else if (line.startsWith('LH:')) hit = Number(line.slice(3)) || 0;
    else if (line === 'end_of_record' && file) {
      const key = path.resolve(REPO, file);
      const prev = out.get(key) || { found: 0, hit: 0 };
      // Several records for one file: keep the best measurement rather than the last.
      out.set(key, { found: Math.max(prev.found, found), hit: Math.max(prev.hit, hit) });
      file = null;
    }
  }
  return out;
}

/** Every file the project counts, discovered — not a list someone maintains beside the code. */
function projectFiles(cfg) {
  const roots = (cfg && cfg.roots) || ['orchestrations/scripts', 'src'];
  const exts = (cfg && cfg.extensions) || ['.js', '.sh', '.ts'];
  const skip = new RegExp((cfg && cfg.excludePattern) || 'node_modules|archived|\\.parked|\\.venv|dist');
  const out = [];
  for (const root of roots) {
    const base = path.join(REPO, root);
    if (!fs.existsSync(base)) continue;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (skip.test(p)) continue;
        if (e.isDirectory()) { walk(p); continue; }
        if (exts.includes(path.extname(p))) out.push(p);
      }
    })(base);
  }
  return out;
}

/** Executable lines: not blank, not a comment, not a bare block delimiter. */
function executableLines(file) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let n = 0; let inBlock = false;
  for (const raw of src.split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (!t || t.startsWith('#') || t.startsWith('//') || t.startsWith('*')) continue;
    if (/^(fi|done|esac|\}|\{|else|elif|then|do|;;)$/.test(t)) continue;
    n += 1;
  }
  return n;
}

/** The files a stage owns. A file belongs to exactly ONE stage, so the totals add up. */
function filesForStage(cfg, stage) {
  const decl = (cfg.stages || {})[stage];
  if (!decl) return null;
  const all = projectFiles(cfg);
  const pats = decl.map((g) => new RegExp(g));
  return all.filter((f) => {
    const rel = f.replace(`${REPO}/`, '');
    return pats.some((re) => re.test(rel));
  });
}

/**
 * CODE THAT BELONGS TO NO STEP BELONGS TO PRE-FLIGHT.
 *
 * Not every file is run by a pipeline step — scaffolding, dashboards, provider shims, one-off
 * checks. Forcing those into a step would be fiction, and letting them fall out of the count would
 * be the flattering denominator this gate exists to prevent.
 *
 * So the remainder is PRE-FLIGHT's, and pre-flight is gated like any other stage: below the
 * ceiling, the pipeline does not start at all. Nothing is excluded and nothing is invented.
 *
 * This is NOT the catch-all that was here before. That one swallowed files into a `shared` stage
 * nobody ran, which made "0 unassigned" true by construction. Pre-flight actually runs, and its
 * gate blocks the whole pipeline rather than one step.
 */
const PREFLIGHT_STAGE = 'preflight';

function ownership(cfg) {
  const all = projectFiles(cfg);
  const owned = new Map();
  for (const stage of Object.keys(cfg.stages || {})) {
    for (const f of filesForStage(cfg, stage) || []) {
      if (!owned.has(f)) owned.set(f, stage);
    }
  }
  const unclaimed = all.filter((f) => !owned.has(f));
  for (const f of unclaimed) owned.set(f, PREFLIGHT_STAGE);
  return { all, owned, unclaimed };
}

function audit(cfg) {
  const { all, owned, unclaimed } = ownership(cfg);
  // Reported for visibility, not as a failure: belonging to no STEP is legitimate. What would be a
  // failure is a file belonging to nothing at all, and that cannot happen — pre-flight owns it.
  const unassigned = [];
  const preflightOnly = unclaimed.map((f) => f.replace(`${REPO}/`, ''));
  let projectLines = 0; for (const f of all) projectLines += executableLines(f);
  let stageLines = 0; for (const f of owned.keys()) stageLines += executableLines(f);
  return {
    projectLines, stageLines, unassigned, files: all.length, assigned: owned.size,
    preflightOnly, preflightOnlyCount: preflightOnly.length,
  };
}

/**
 * THE MEASUREMENT IS PERSISTED, NOT RECOMPUTED.
 *
 * Answering "how covered is this stage" means parsing lcov and reading every in-scope file to count
 * its executable lines. That is the expensive part, and it is asked once per stage entry — the
 * writer stage is entered once per seam. Paying it every time would put a filesystem sweep in front
 * of every model call, for an answer that cannot have changed since the last one: no test ran in
 * between.
 *
 * So it is computed ONCE, by --persist, and written to coverage/stage-coverage.json. Every gate
 * after that reads a number out of a small JSON file.
 *
 * STALE IS NOT FRESH, AND THAT IS THE WHOLE DIFFICULTY. A persisted number that outlived the code it
 * measured is worse than no number: it reports cover that no longer exists, which is precisely the
 * silence this gate was built to end. The report therefore carries a FINGERPRINT of everything the
 * answer depends on — every in-scope file's size and mtime, the lcov data, and the stage map itself.
 * Building it costs one stat per file and no reads at all, so checking freshness stays cheap while
 * the thing it guards stays honest.
 *
 * A stale or missing report is not an error: the handler computes the answer the slow way and
 * persists it on the way out. Correctness never depends on the cache being warm — only speed does.
 */
const REPORT = process.env.STAGE_COVERAGE_REPORT || path.join(REPO, 'coverage/stage-coverage.json');

/**
 * HAS THE SUITE ACTUALLY SEEN THIS TREE?
 *
 * The fingerprint proves the report matches lcov. It says nothing about whether lcov matches the
 * SOURCE — and that is the gap that made this whole gate a formality. Run the suite at 100%, add a
 * hundred brand-new untested lines, do not re-run it: the report is correctly invalidated, then
 * recomputed against coverage data that predates the code and still reports 100%. The untested code
 * is invisible, which is precisely what this gate exists to prevent.
 *
 * Recomputing cannot fix it. The INPUT is stale, so every answer derived from it is stale. The only
 * honest response is to refuse and say the suite has not been run since the code changed.
 *
 * It fails CLOSED, and that is the point: nobody has to remember to refresh the measurement,
 * because nothing runs until they do. mtime is a coarse signal — a checkout or a touch will trip it
 * — but it errs toward "run the suite again", which is the safe direction. Erring the other way is
 * how a run pays for code nobody tested.
 */
function sourcesNewerThanCoverage(cfg) {
  let lcovMtime;
  try { lcovMtime = fs.statSync(LCOV).mtimeMs; } catch { return null; } // absence is handled elsewhere
  const moved = [];
  for (const f of projectFiles(cfg)) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs > lcovMtime) moved.push(f.replace(`${REPO}/`, ''));
  }
  return moved;
}

function refuseStaleCoverage(moved) {
  const shown = moved.slice(0, 5).join(', ');
  const more = moved.length > 5 ? ` (and ${moved.length - 5} more)` : '';
  die(`the coverage data at ${LCOV} is OLDER than ${moved.length} file(s) it is supposed to `
    + `measure: ${shown}${more}. A percentage computed from it would describe code that no longer `
    + 'exists, and would hide every line added since. Re-run the suite: npm run test:coverage', 5);
}

function fingerprint(cfg) {
  const parts = [];
  for (const f of projectFiles(cfg)) {
    try { const st = fs.statSync(f); parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`); }
    catch { parts.push(`${f}:missing`); }
  }
  for (const f of [LCOV, CONFIG]) {
    try { const st = fs.statSync(f); parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`); }
    catch { parts.push(`${f}:missing`); }
  }
  return require('crypto').createHash('sha1').update(parts.join('\n')).digest('hex');
}

/** Percentage for one stage, computed from lcov and the files that stage runs. */
function measure(cfg, stage) {
  let files;
  if (stage === PREFLIGHT_STAGE) {
    const { owned } = ownership(cfg);
    files = [...owned.entries()].filter(([, s2]) => s2 === PREFLIGHT_STAGE).map(([f]) => f);
  } else {
    files = filesForStage(cfg, stage);
  }
  if (!files) return null;
  const cov = lcovByFile();
  if (cov === null) return null; // absent is not full; the caller decides how to refuse
  let found = 0; let hit = 0;
  for (const f of files) {
    const rec = cov.get(f);
    if (rec) { found += rec.found; hit += rec.hit; continue; }
    // A FILE THE STAGE RUNS THAT THE SUITE NEVER SAW contributes its lines as UNCOVERED. Treating it
    // as absent would let a stage raise its score by having files nothing tests.
    found += executableLines(f);
  }
  if (found === 0) {
    // A STAGE MATCHING NO CODE IS A BROKEN DECLARATION, NOT AN UNCOVERED ONE. Scoring it 0% would
    // halt the pipeline forever over code that does not exist — a gate nobody can satisfy, which is
    // worse than no gate at all. It is almost always a pattern that stopped matching after a rename.
    return { found: 0, hit: 0, pct: null, empty: true };
  }
  return { found, hit, pct: found ? (hit / found) * 100 : 0 };
}

function persist(cfg) {
  const stages = {};
  for (const stage of Object.keys(cfg.stages)) stages[stage] = measure(cfg, stage);
  const report = { generatedAt: new Date().toISOString(), fingerprint: fingerprint(cfg), stages };
  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  } catch { /* an unwritable cache slows the gate down; it must never fail it */ }
  return report;
}

/** The persisted answer for a stage, or null when there is none that still applies. */
function fromReport(cfg, stage) {
  let report;
  try { report = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { return null; }
  if (!report || typeof report !== 'object' || !report.stages) return null;
  if (report.fingerprint !== fingerprint(cfg)) return null; // measured code that no longer exists
  const entry = report.stages[stage];
  if (!entry) return null;
  // An empty stage is a real, persisted finding — hand it back so the refusal is instant too.
  if (entry.empty) return entry;
  return typeof entry.pct === 'number' ? entry : null;
}

const arg = process.argv[2];
if (!arg) die('usage: stage-coverage.js <stage> | --all | --persist | --audit | --stages | --policy');

const cfg = config();

if (arg === '--stages') {
  // Pre-flight gates every declared stage, so it has to ask WHICH — a list hard-coded in the shell
  // would drift from the map the moment a stage is added, and the stage that drifts is the one
  // nobody is watching.
  process.stdout.write(Object.keys(cfg.stages).join('\n') + '\n');
  process.exit(0);
}

if (arg === '--policy') {
  process.stdout.write(JSON.stringify(policy()));
  process.exit(0);
}

if (arg === '--all') {
  const moved = sourcesNewerThanCoverage(cfg);
  if (moved && moved.length) refuseStaleCoverage(moved);
  // Pre-flight asks about every stage. Asking one process fourteen questions costs one startup;
  // asking fourteen processes one question each costs fourteen, and startup is now the whole bill.
  const r = fromReport(cfg, PREFLIGHT_STAGE) ? JSON.parse(fs.readFileSync(REPORT, 'utf8'))
    : (lcovByFile() === null ? null : persist(cfg));
  if (!r) {
    die(`no coverage data at ${LCOV} — nothing was measured, which is not the same as everything `
      + 'being covered. Run the suite before the pipeline.', 3);
  }
  for (const [stage, e] of Object.entries(r.stages)) {
    process.stdout.write(`${stage} ${e ? Math.round(e.pct * 10) / 10 : ''}\n`);
  }
  process.exit(0);
}

if (arg === '--persist') {
  // Run this once, where the suite runs. Every gate afterwards reads its output.
  process.stdout.write(JSON.stringify(persist(cfg), null, 2));
  process.exit(0);
}

if (arg === '--audit') {
  process.stdout.write(JSON.stringify(audit(cfg), null, 2));
  process.exit(0);
}

// THE FAST PATH: a persisted measurement that still applies to this tree.
//
// The slow path below stays, and stays authoritative. A missing or stale report costs time, never
// correctness — and a stale one is never used, because the fingerprint covers every file the answer
// depends on.
if (!cfg.stages[arg] && arg !== PREFLIGHT_STAGE) {
  die(`stage '${arg}' is not declared in ${CONFIG} — an unknown stage is not a covered one`);
}

function refuseEmpty(stage) {
  die(`stage '${stage}' matches no file in ${CONFIG} — its patterns select nothing, so there is `
    + 'nothing to measure. Fix the declaration; a stage with no code must not be scored 0%.', 4);
}

const movedSinceSuite = sourcesNewerThanCoverage(cfg);
if (movedSinceSuite && movedSinceSuite.length) refuseStaleCoverage(movedSinceSuite);

const cached = fromReport(cfg, arg);
if (cached) {
  if (cached.empty) refuseEmpty(arg);
  process.stdout.write(String(Math.round(cached.pct * 10) / 10));
  process.exit(0);
}

// No usable report. Compute it — and persist the whole map on the way out, so the stages after this
// one read a number instead of sweeping the tree again.
if (lcovByFile() === null) {
  // ABSENT IS NOT FULL. This is the state before anyone has run the suite, and it is exactly the
  // state in which a stage must not be allowed to spend.
  die(`no coverage data at ${LCOV} — nothing was measured, which is not the same as everything `
    + 'being covered. Run the suite before the pipeline.', 3);
}

const report = persist(cfg);
const entry = report.stages[arg];
if (!entry) die(`stage '${arg}' could not be measured`, 3);
if (entry.empty) refuseEmpty(arg);
process.stdout.write(String(Math.round(entry.pct * 10) / 10));
