#!/usr/bin/env node
/**
 * detective-rerun-step — re-investigate the fix sites, and nothing else.
 *
 * WHY THIS EXISTS. The detective's contract gained a required field, `changeRequired`: true
 * when the fix means editing this file, false when the file is genuinely part of the fix and
 * needs no edit of its own. A downstream gate demands a real diff in every site not marked
 * false. A PRD written before the field existed carries it as `undefined` on every site, so
 * the gate demands a diff for a file whose own prescription reads "no code change required" —
 * the implementer correctly changes nothing, the gate rejects, and every retry reproduces it.
 *
 * The obvious repair is a full spec pass. That regenerates acceptance criteria, verification
 * criteria and story splits to obtain one boolean, and its fix-site propagation is
 * non-deterministic by this codebase's own record. This step is the narrow one: it re-runs the
 * SAME investigation the spec pass would run, merges the answer back into fixSiteAnalysis, and
 * touches nothing else in the PRD.
 *
 * ABSENT IS NOT EMPTY. A codeline whose detective returns no findings, or throws, KEEPS its
 * existing prescription. An empty answer is false-because-unknown; only a non-empty answer is
 * evidence. This pipeline has already destroyed correct partial work by treating the two the
 * same, and the per-codeline prescriptions here are the output of a run that cost real money.
 *
 * Exit non-zero when a selected codeline still has sites without the boolean — the whole point
 * of the step is that field arriving, and a step that silently half-worked would send the
 * writer back into the same unwinnable gate.
 *
 *   node detective-rerun-step.js --prd <path> [--codelines a,b] [--story ID] [--log-dir <dir>]
 *   node detective-rerun-step.js --prd <path> --report        (read-only: what is missing)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const spec = require('./spec-mode-runner.js');

const argv = process.argv.slice(2);
const getArg = (flag, def = '') => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : def;
};
const hasFlag = (flag) => argv.includes(flag);

/**
 * The codelines this PRD declares, in declaration order.
 *
 * The PRD is the only source. Ingest discovers them and writes them here; an engine that
 * carried its own list would be describing one project.
 */
function codelinesFromPrd(prd) {
  const declared = (prd && prd.project && prd.project.outputDirs) || [];
  return declared
    .filter((d) => d && d.codeline)
    .map((d) => ({ name: d.codeline, path: d.path || '' }));
}

/** Codelines a story is actually in scope for. */
function storyCodelines(story) {
  const list = Array.isArray(story.codelines) ? story.codelines.filter(Boolean) : [];
  if (list.length) return list;
  return story.codeline ? [story.codeline] : [];
}

/** Sites carry a boolean or they carry nothing — `undefined` is the state this step repairs. */
function sitesMissingTheField(sites) {
  return (Array.isArray(sites) ? sites : [])
    .filter((f) => f && typeof f.changeRequired !== 'boolean');
}

/**
 * Rebuild the flat list from the per-codeline truth.
 *
 * The flat array is what most consumers read, and a single array cannot be correct across
 * repositories that spell the same file differently — which is why every entry carries the
 * codeline it belongs to. Entries whose codeline this run did not touch are carried through
 * unchanged rather than regenerated.
 */
function rebuildFlat(story) {
  const per = story.fixSiteAnalysisPerCodeline || {};
  const known = new Set(Object.keys(per));
  const untouched = (Array.isArray(story.fixSiteAnalysis) ? story.fixSiteAnalysis : [])
    .filter((f) => f && !known.has(f.codeline));
  const fromPer = Object.keys(per).flatMap((cl) => (Array.isArray(per[cl]) ? per[cl] : []));
  return [...untouched, ...fromPer];
}

/**
 * Write the PRD, leaving a restorable copy of what was there.
 *
 * Not a convenience. The prescriptions being replaced are the output of an expensive run, and
 * a re-investigation is a fresh draw that can come back worse. The backup is what makes this
 * step reversible, which is the only reason it is safe to run at all.
 */
function writePrd(prdPath, prd, stamp) {
  const tag = stamp || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backup = `${prdPath}.pre-detective-rerun-${tag}`;
  try {
    if (fs.existsSync(prdPath) && !fs.existsSync(backup)) {
      fs.copyFileSync(prdPath, backup);
    }
  } catch (err) {
    // A write we cannot undo is not one to make quietly.
    throw new Error(`could not back up ${prdPath} (${err && err.message}) — refusing to overwrite it`);
  }
  const tmp = `${prdPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(prd, null, 2));
  fs.renameSync(tmp, prdPath);
  return backup;
}

/**
 * Run the detective once per (story, codeline) and merge what comes back.
 *
 * `detective` is injectable so the merge — where every destructive mistake lives — is testable
 * without spending an agent call. The default is the pipeline's own investigator, so this step
 * and the spec pass cannot drift into asking different questions.
 */
async function runRerun({
  prd,
  detective = spec.runCodeGraphDetective,
  codelines = null,
  logDir = '',
  storyIds = null,
  onProgress = null,
  promptExec = undefined,
  agentsDir = null,
} = {}) {
  // THE MINTED BRIEFS, RE-APPLIED BEFORE ANYTHING IS INVOKED.
  //
  // profiles.json is restored to its canonical base at launch, which deletes every brief the
  // mint wrote; the project's own copy is re-applied by the step that owns the roster. This
  // step invokes an agent WITHOUT going through that step, so without this the detective runs
  // on the canonical fallback and the per-codeline investigator — the whole reason one is
  // minted — is silently unused. Live 2026-08-11: exactly that, reported as "no investigator
  // is bound to this codeline" when three were bound and none had a brief.
  const _agentsDir = agentsDir || path.join(__dirname, '..', 'agents');
  try {
    const roster = require('./lib/agent-roster.js');
    const applied = roster.applyProjectProfiles(path.join(_agentsDir, 'profiles.json'), _agentsDir);
    if (applied && applied.length) {
      process.stderr.write(`[detective-rerun] re-applied ${applied.length} project brief(s): ${applied.join(', ')}\n`);
    }
  } catch (err) {
    // Not fatal: the canonical detective is a real fallback. Said out loud, because a run on
    // the generic brief answers differently from one on the codeline's own.
    process.stderr.write(`[detective-rerun] could not re-apply project briefs (${err && err.message}) — using canonical profiles\n`);
  }

  // THE SEARCH-VOCABULARY DERIVATION NEEDS AN EXECUTOR, AND HAD NONE.
  //
  // deriveGuardVocabulary reads opts.promptExec. Passing {} left it null, so the derivation
  // threw ("Cannot read properties of null (reading 'cmd')"), the detective seeded with an
  // UNFILTERED query, and its first and most expensive tool call went on noise. It then ran out
  // of time. The pipeline's own caller supplies this; a standalone driver must too.
  const _promptExec = promptExec !== undefined
    ? promptExec
    : (() => {
      try {
        return spec.resolvePromptExec(process.env.AI_RUNNER_CMD || path.join(__dirname, 'ai-run.sh'));
      } catch { return null; }
    })();
  const declared = codelinesFromPrd(prd);
  const byName = new Map(declared.map((c) => [c.name, c]));
  const selected = (codelines && codelines.length ? codelines : declared.map((c) => c.name))
    .filter(Boolean);

  const stories = (Array.isArray(prd.stories) ? prd.stories : [])
    .filter((s) => s && (!storyIds || !storyIds.length || storyIds.includes(s.id) || storyIds.includes(s.jiraKey)));

  const results = [];
  const saved = {
    PROJECT_ROOT: process.env.PROJECT_ROOT,
    EPAM_CODELINE: process.env.EPAM_CODELINE,
    EPAM_AGENT_NAME: process.env.EPAM_AGENT_NAME,
  };

  try {
    for (const story of stories) {
      const inScope = storyCodelines(story).filter((cl) => selected.includes(cl));
      for (const cl of inScope) {
        const repo = (byName.get(cl) || {}).path || '';
        // The detective resolves its repository from the story's codeline via the environment.
        // Set per lane, restored in the finally below: a stale PROJECT_ROOT here would brief an
        // investigator on another repository, which is the contamination the per-codeline split
        // exists to prevent.
        process.env.EPAM_CODELINE = cl;
        if (repo) process.env.PROJECT_ROOT = repo;
        process.env.EPAM_AGENT_NAME = 'code-graph-detective';

        // A COPY, carrying this lane's codeline. The detective reads story.codeline to resolve
        // its repo, and mutating the PRD's own object would leave the last lane's name on it.
        const laneStory = { ...story, codeline: cl };

        const before = (story.fixSiteAnalysisPerCodeline || {})[cl] || [];
        let findings = null;
        let error = '';
        try {
          findings = await detective(laneStory, logDir, { promptExec: _promptExec });
        } catch (err) {
          error = (err && err.message) || String(err);
        }

        let status;
        if (error) {
          status = 'failed';
        } else if (!Array.isArray(findings) || !findings.length) {
          // See the header: an empty answer is not evidence of no fix site.
          status = 'kept';
        } else {
          const stamped = findings
            .filter((f) => f && f.reason)
            .map((f) => (f.codeline ? f : { ...f, codeline: cl }));
          if (stamped.length) {
            story.fixSiteAnalysisPerCodeline = { ...(story.fixSiteAnalysisPerCodeline || {}), [cl]: stamped };
            status = 'replaced';
          } else {
            status = 'kept';
          }
        }

        const after = (story.fixSiteAnalysisPerCodeline || {})[cl] || [];
        const row = {
          storyId: story.id,
          codeline: cl,
          status,
          before: before.length,
          after: after.length,
          missingField: sitesMissingTheField(after).map((f) => f.file),
        };
        if (error) row.error = error;
        results.push(row);
        if (onProgress) onProgress(row);
      }

      if (story.fixSiteAnalysisPerCodeline) {
        story.fixSiteAnalysis = rebuildFlat(story);
        // Coverage is derived from the prescription, so a replaced prescription invalidates the
        // stored coverage. Recomputed where the function is available; left alone otherwise
        // rather than written as a guess.
        try {
          if (typeof spec.coverageForStory === 'function') {
            story.fixSiteAnalysisCoverage = spec.coverageForStory(story);
          }
        } catch { /* the stored coverage stands */ }
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const unresolved = results.filter((r) => r.missingField.length);
  return { results, unresolved };
}

/** What is missing right now, without running anything. */
function report(prd, codelines = null) {
  const declared = codelinesFromPrd(prd).map((c) => c.name);
  const selected = codelines && codelines.length ? codelines : declared;
  const rows = [];
  for (const story of (Array.isArray(prd.stories) ? prd.stories : [])) {
    const per = story.fixSiteAnalysisPerCodeline || {};
    for (const cl of storyCodelines(story).filter((c) => selected.includes(c))) {
      const sites = per[cl] || [];
      rows.push({
        storyId: story.id,
        codeline: cl,
        sites: sites.length,
        missingField: sitesMissingTheField(sites).map((f) => f.file),
      });
    }
  }
  return rows;
}

module.exports = {
  codelinesFromPrd,
  storyCodelines,
  sitesMissingTheField,
  rebuildFlat,
  writePrd,
  runRerun,
  report,
};

if (require.main !== module) return;

(async () => {
  const PRD_PATH = getArg('--prd');
  if (!PRD_PATH || !fs.existsSync(PRD_PATH)) {
    process.stderr.write('[detective-rerun] --prd <path> is required and must exist\n');
    process.exit(2);
  }
  const LOG_DIR = getArg('--log-dir', process.env.OUTPUT_DIR || path.join(__dirname, '..', 'logs'));
  const only = getArg('--codelines', process.env.EPAM_ONLY_CODELINES || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  const storyIds = getArg('--story', '').split(',').map((x) => x.trim()).filter(Boolean);

  const prd = JSON.parse(fs.readFileSync(PRD_PATH, 'utf8'));

  if (hasFlag('--report')) {
    for (const r of report(prd, only)) {
      process.stderr.write(
        `[detective-rerun] ${r.storyId}/${r.codeline}: ${r.sites} site(s), ` +
        `${r.missingField.length} missing changeRequired` +
        `${r.missingField.length ? ` — ${r.missingField.join(', ')}` : ''}\n`);
    }
    process.exit(0);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  process.stderr.write(
    `[detective-rerun] re-investigating ${only.length ? only.join(', ') : 'every declared codeline'}\n`);

  const { results, unresolved } = await runRerun({
    prd,
    codelines: only,
    logDir: LOG_DIR,
    storyIds,
    onProgress: (r) => process.stderr.write(
      `[detective-rerun]   ${r.storyId}/${r.codeline}: ${r.status} ` +
      `(${r.before} -> ${r.after} site(s))${r.error ? ` — ${r.error}` : ''}\n`),
  });

  // Persisted at generation time: a result that exists only in a log line is a defect.
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'detective-rerun.json'), JSON.stringify({ results, unresolved }, null, 2));
  } catch { /* the summary below still reports it */ }

  if (results.some((r) => r.status === 'replaced')) {
    const backup = writePrd(PRD_PATH, prd);
    process.stderr.write(`[detective-rerun] PRD written; previous copy at ${backup}\n`);
  } else {
    process.stderr.write('[detective-rerun] nothing was replaced — PRD left untouched\n');
  }

  if (unresolved.length) {
    for (const u of unresolved) {
      process.stderr.write(
        `[detective-rerun] ! ${u.storyId}/${u.codeline}: ${u.missingField.length} site(s) still ` +
        `carry no changeRequired — ${u.missingField.join(', ')}\n`);
    }
    process.stderr.write(
      '[detective-rerun] FAILED: the gate these sites feed demands a diff for every site not ' +
      'marked false, so the story stays unwinnable on the codelines above.\n');
    process.exit(1);
  }
  process.stderr.write('[detective-rerun] ✓ every selected site carries changeRequired\n');
})().catch((err) => {
  process.stderr.write(`[detective-rerun] FAILED: ${(err && err.message) || err}\n`);
  process.exit(1);
});
