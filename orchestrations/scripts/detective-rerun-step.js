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
const { publishFixPlans } = require('./lib/producers/fix-plan.js');
const path = require('path');

const spec = require('./spec-mode-runner.js');
// Which build-config files a new dependency can force a change to is a STACK FACT. It lives
// in the project's declaration and is read through the plugin — never inferred here.
const depPlugin = require('../plugins/dependency-scan-plugin.js');

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
  // A STORY THAT IS NOT THERE HAS NO CODELINES. This dereferenced whatever it was handed, so a
  // malformed PRD — a null in the stories array, a story a failed step never finished writing —
  // threw here instead of being reported as a story with no codelines.
  if (!story || typeof story !== 'object') return [];
  const list = Array.isArray(story.codelines) ? story.codelines.filter(Boolean) : [];
  if (list.length) return list;
  return story.codeline ? [story.codeline] : [];
}

/**
 * A NEW DEPENDENCY IMPLICATES BUILD CONFIGURATION, AND NOTHING ELSE DERIVES THAT.
 *
 * The detective enumerates CODE fix sites from the ticket; verification criteria are
 * behavioural by design (all four on AMSD-2041 were about rendering and auth). So when a
 * story adds a package, the files that must be told about it — the test runner's transform
 * list, the bundler's resolver, the type checker's paths — are owned by NO ACTOR.
 *
 * Live AMSD-2041/gotransit, 2026-08-11: @contentstack/live-preview-utils is ESM;
 * jest.config.js hard-codes which packages to transpile; Jest died on `export` every
 * attempt. jest.config.js was writable the whole run — THE WRITER WAS NOT BLOCKED, IT WAS
 * UNGUIDED. This is not fixed by widening permissions.
 *
 * WHICH files are dependency-sensitive is a STACK FACT, declared in the project's
 * dependency-check.json and read through the plugin. The engine never infers it and it
 * never enters a generic agent prompt: true here, wrong for the next project.
 *
 * WHAT IT EMITS: a candidate carrying NEITHER verdict.
 *   changeRequired absent — "not yet investigated", NOT "no change needed". Collapsing
 *     those two is what made a story unwinnable once already.
 *   fixVerified absent    — the detective has not confirmed this site, and claiming it had
 *     would put the file straight into the enforcement gate on the strength of a guess.
 * The candidate is therefore VISIBLE (it is a fix site, with a reason) and NOT YET ENFORCED,
 * which is exactly what an uninvestigated lead should be.
 */
function dependencyConfigCandidates(sites, projectRoot, env, plugin) {
  const packages = [...new Set(
    (Array.isArray(sites) ? sites : [])
      .flatMap((f) => (f && Array.isArray(f.requiredPackages) ? f.requiredPackages : []))
      .filter((p) => typeof p === 'string' && p.trim()),
  )];
  if (!packages.length) return { candidates: [], packages, note: '' };

  let decl;
  try {
    decl = plugin.dependencySensitiveConfigFiles(projectRoot, env);
  } catch (e) {
    return { candidates: [], packages, note: `dependency-sensitive config lookup failed: ${e && e.message}` };
  }
  // Undeclared is UNKNOWN, and the caller reports it. Silence here would read as
  // "this project has no build config", which is a claim nobody made.
  if (!decl.ok) return { candidates: [], packages, note: decl.reason };

  const already = new Set((Array.isArray(sites) ? sites : []).map((f) => f && f.file));
  const candidates = decl.files
    .filter((file) => !already.has(file))
    .map((file) => ({
      file,
      reason: `This story adds ${packages.join(', ')}. ${file} is declared as a file a new `
        + 'dependency can force a change to. Investigate whether this package requires a change '
        + 'here, and record changeRequired accordingly.',
      // The writer prompt renders "- **file** (`function`): reason" and jq treats a MISSING
      // .function as null, which renders a literal (`null`). Empty string, not absent.
      function: '',
      requiredPackages: packages,
      candidateFrom: 'dependency-sensitive-config',
    }));
  return { candidates, packages, note: '' };
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
  // Same as storyCodelines: nothing to rebuild from a story that is not an object.
  if (!story || typeof story !== 'object') return [];
  const per = story.fixSiteAnalysisPerCodeline || {};
  const known = new Set(Object.keys(per));
  const untouched = (Array.isArray(story.fixSiteAnalysis) ? story.fixSiteAnalysis : [])
    .filter((f) => f && !known.has(f.codeline));
  const fromPer = Object.keys(per).flatMap((cl) => (Array.isArray(per[cl]) ? per[cl] : []));
  return [...untouched, ...fromPer];
}

/**
 * Does replacing `before` with `after` LOSE GROUND?
 *
 * The step's whole safety argument is that it is reversible — "the backup is what makes this
 * step reversible, which is the only reason it is safe to run at all". A backup is reversible
 * only if somebody compares it, and nobody did. Live 2026-08-11 the same detective, same
 * codeline, same ticket, 40 minutes apart, replaced a prescription carrying the step that
 * built the feature with one that had neither it nor the file it lived in — and the row this
 * step logs said `before: 13, after: 14`. THE COUNT WENT UP. Counting cannot see this.
 *
 * Structural only. Nothing here knows what the project is, what a good fix looks like, or what
 * any file does — it asks whether the new prescription still covers what the old one covered:
 *
 *   site-lost              a file that had a site has none now
 *   change-required-lost   a site that had to be EDITED is now exempt
 *   packages-lost          a declared package requirement vanished
 *   fix-verified-lost      a site whose helper was verified no longer is
 *
 * Returns [] when the replacement holds its ground (including replacing a prescription with
 * itself). Additions are never regressions — a fresh draw finding MORE is the point of it.
 */
function prescriptionRegressions(before, after) {
  const prev = Array.isArray(before) ? before.filter(Boolean) : [];
  const next = Array.isArray(after) ? after.filter(Boolean) : [];
  if (!prev.length) return [];

  const byFile = (list) => {
    const m = new Map();
    for (const f of list) {
      const k = String(f.file || '');
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return m;
  };
  const P = byFile(prev);
  const N = byFile(next);
  const out = [];

  for (const [file, was] of P) {
    const now = N.get(file);
    if (!now || !now.length) {
      out.push({
        kind: 'site-lost',
        file,
        detail: 'the previous prescription had a fix site here and the replacement has none',
      });
      continue;
    }
    // Required-ness: only an explicit false is exempt, matching the enforcement gate's own
    // reading (claude.sh: `changeRequired | type == "boolean" and . == false`). A site that was
    // required and is now exempt means the replacement claims work is unnecessary that the
    // previous investigation said was essential — the 2026-08-11 "all five false" shape.
    const wasRequired = was.some((f) => f.changeRequired === true);
    const nowExempt = now.every((f) => f.changeRequired === false);
    if (wasRequired && nowExempt) {
      out.push({
        kind: 'change-required-lost',
        file,
        detail: 'was marked as needing an edit; the replacement marks it exempt',
      });
    }
    const pkgs = (list) => new Set(list.flatMap((f) => (Array.isArray(f.requiredPackages) ? f.requiredPackages : [])));
    const wasPkgs = pkgs(was);
    const nowPkgs = pkgs(now);
    for (const pkg of wasPkgs) {
      if (!nowPkgs.has(pkg)) {
        out.push({
          kind: 'packages-lost',
          file,
          detail: `declared package "${pkg}" is no longer declared`,
        });
      }
    }
    if (was.some((f) => f.fixVerified === true) && now.every((f) => f.fixVerified === false)) {
      out.push({
        kind: 'fix-verified-lost',
        file,
        detail: 'the named helper was verified to exist before and is not verified now',
      });
    }
  }
  return out;
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

  // The plan changed, so every consumer's copy of it changes with it. Publishing HERE — at the
  // one place a re-run persists its answer — is what stops a withdrawn finding being served for
  // the rest of the run: publishFixPlans clears a story whose sites are now empty.
  try {
    const n = publishFixPlans(prd);
    process.stderr.write(`[detective-rerun] published fix-plan for ${n} story(ies)\n`);
  } catch (err) {
    // Never fail the write because publication failed — but never hide it either.
    process.stderr.write(`[detective-rerun] WARNING: fix-plan publication failed: ${(err && err.message) || err}\n`);
  }

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

  // A regression may be accepted only by EXPLICIT permission — never by default, and never
  // silently: the row records it either way.
  const allowRegression = String(process.env.EPAM_ALLOW_PRESCRIPTION_REGRESSION || '') === '1';

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
        let regressions = [];
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
            // DOES THIS DRAW HOLD ITS GROUND? A fresh draw that LOSES a prescribed site, or
            // downgrades one from "must edit" to "exempt", or drops a package declaration, is
            // contained here rather than written over the prescription that already stands.
            // Live 2026-08-11 this exact replacement went through and reported success; the
            // row said before:13 after:14, because counting cannot see a lost instruction.
            // The previous prescription is KEPT — it is the one with evidence behind it — and
            // the loss is named so a human can decide, which is what the backup was always
            // supposed to enable and never did.
            regressions = prescriptionRegressions(before, stamped);
            if (regressions.length && !allowRegression) {
              status = 'rejected-regression';
            } else {
              if (regressions.length) {
                // Explicitly permitted: still recorded, never silent.
                status = 'replaced-with-regression';
              } else {
                status = 'replaced';
              }
              story.fixSiteAnalysisPerCodeline = { ...(story.fixSiteAnalysisPerCodeline || {}), [cl]: stamped };
            }
          } else {
            status = 'kept';
          }
        }

        // Derive build-config candidates from whatever prescription now stands for this
        // codeline — after the detective, so a replaced set is the one examined, and so a
        // failed/kept lane still gets candidates from its retained sites.
        const current = (story.fixSiteAnalysisPerCodeline || {})[cl] || [];
        const derived = dependencyConfigCandidates(current, repo || process.env.PROJECT_ROOT || '', process.env, depPlugin);
        if (derived.candidates.length) {
          const withCodeline = derived.candidates.map((c) => ({ ...c, codeline: cl }));
          story.fixSiteAnalysisPerCodeline = {
            ...(story.fixSiteAnalysisPerCodeline || {}),
            [cl]: [...current, ...withCodeline],
          };
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
        if (derived.packages.length) {
          row.requiredPackages = derived.packages;
          row.configCandidates = derived.candidates.map((c) => c.file);
          // An undeclared manifest key is reported, never swallowed: "we could not tell which
          // build-config files a dependency affects" must not read as "there are none".
          if (derived.note) row.configCandidatesNote = derived.note;
        }
        if (regressions.length) row.regressions = regressions;
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
  prescriptionRegressions,
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
  const only = getArg('--codelines', '')
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

  if (hasFlag('--derive-config-candidates')) {
    // DERIVE WITHOUT RE-INVESTIGATING.
    //
    // The candidate derivation reads requiredPackages off the prescription that already
    // stands; it needs no LLM call. Coupling it to the re-investigation would mean the only
    // way to add a build-config candidate is to take a FRESH DRAW of the whole prescription
    // — and a fresh draw can come back worse. Live 2026-08-11: a re-run of AMSD-2041/gotransit
    // replaced a correct prescription (3 sites changeRequired:true, one carrying
    // requiredPackages) with one asserting changeRequired:false on ALL FIVE sites and no
    // packages at all, then reported "✓ every selected site carries changeRequired" — true,
    // and all false. Reverted from the backup.
    //
    // So this mode exists to make the cheap, deterministic half available on its own.
    const rows = [];
    for (const story of prd.stories || []) {
      if (storyIds.length && !storyIds.includes(story.id)) continue;
      const per = story.fixSiteAnalysisPerCodeline || {};
      for (const cl of Object.keys(per)) {
        if (only.length && !only.includes(cl)) continue;
        const current = Array.isArray(per[cl]) ? per[cl] : [];
        const repo = (codelinesFromPrd(prd).find((c) => c.name === cl) || {}).path || process.env.PROJECT_ROOT || '';
        const derived = dependencyConfigCandidates(current, repo, process.env, depPlugin);
        const row = { storyId: story.id, codeline: cl, packages: derived.packages, added: [] };
        if (derived.note) row.note = derived.note;
        if (derived.candidates.length) {
          story.fixSiteAnalysisPerCodeline[cl] = [
            ...current,
            ...derived.candidates.map((c) => ({ ...c, codeline: cl })),
          ];
          row.added = derived.candidates.map((c) => c.file);

          // AND INTO THE LIST THE WRITER ACTUALLY READS.
          //
          // fixSiteAnalysis is NOT the writer's file list. build_implementation_prompt
          // iterates story_declared_files(), which reads technicalNotes.perCodeline[cl].files
          // (falling back to technicalNotes.files); fixSiteAnalysis only decides whether a
          // DECLARED file gets its content injected. A candidate present in one and absent
          // from the other is invisible to the writer — the same "wired one end of the
          // contract, never checked the other" shape as the defects this whole exercise is
          // cleaning up. Caught by reading the prompt builder, not by a live run.
          const tn = story.technicalNotes || (story.technicalNotes = {});
          const perCl = tn.perCodeline && tn.perCodeline[cl] && Array.isArray(tn.perCodeline[cl].files);
          const list = perCl ? tn.perCodeline[cl].files : (Array.isArray(tn.files) ? tn.files : null);
          if (list) {
            for (const c of derived.candidates) if (!list.includes(c.file)) list.push(c.file);
            row.declaredIn = perCl ? `technicalNotes.perCodeline.${cl}.files` : 'technicalNotes.files';
          } else {
            // No list to append to means the writer would never be told. Say so; do not
            // pretend the candidate was delivered.
            row.note = `${row.note ? `${row.note}; ` : ''}no technicalNotes file list for ${cl} — `
              + 'the candidate is in fixSiteAnalysis but WILL NOT reach the writer';
          }
        }
        rows.push(row);
      }
      if (story.fixSiteAnalysisPerCodeline) story.fixSiteAnalysis = rebuildFlat(story);
    }
    const anyAdded = rows.some((r) => r.added.length);
    for (const r of rows) {
      process.stderr.write(
        `[detective-rerun] ${r.storyId}/${r.codeline}: packages=[${r.packages.join(', ')}] `
        + `candidates=[${r.added.join(', ')}]${r.declaredIn ? ` -> ${r.declaredIn}` : ''}`
        + `${r.note ? ` — ${r.note}` : ''}\n`);
    }
    if (anyAdded) {
      const backup = writePrd(PRD_PATH, prd, getArg('--stamp', ''));
      process.stderr.write(`[detective-rerun] PRD written; previous copy at ${backup}\n`);
    } else {
      process.stderr.write('[detective-rerun] nothing to add — PRD left untouched\n');
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
