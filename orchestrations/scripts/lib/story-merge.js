'use strict';

/**
 * Merging a lane's story state back into the canonical PRD.
 *
 * Each codeline runs against its own filtered PRD copy (<codeline>-prd.json) and writes its
 * real outcome there. That file is deleted at the end of the lane loop, so whatever is not
 * merged back is lost: the canonical PRD is what the dashboard, the run report, a rerun
 * deciding what is outstanding, and every downstream consumer actually read.
 *
 * The hazard is that a SPANNING story is touched by every lane, so a whole-object merge is
 * last-writer-wins. Two defects of that shape have now been found live:
 *
 *   1. Status (fixed 2026-07-23): a story that failed in one codeline and succeeded in
 *      another read as whichever lane happened to run last.
 *   2. Verification criteria (fixed 2026-08-08): each lane specs against its OWN checkout
 *      and produces the criteria observable in THAT codeline. On AMSD-2041 metrolinx
 *      produced criteria naming newsService.ts / getEventsList.ts, files that do not exist
 *      in gotransit or upexpress — and because metrolinx merged last, those became the whole
 *      story's criteria. The spec reviewer scored the result 0.65, correctly noting that an
 *      implementer sent to GO or UP could not function.
 *
 * Both are the same shape and take the same remedy, which technicalNotes.perCodeline
 * established first: record each lane's answer under its own codeline key, and derive the
 * story-level value from all of them rather than from the last one to arrive.
 *
 * The per-lane PRD is deliberately NOT touched. Its flat verificationCriteria is that lane's
 * own, which is correct there and is what the writers, gates and reviewers read during the
 * lane's own execution. Only the canonical view needs to hold every lane at once.
 */

/** Criteria as a clean string list — a lane may return junk, nothing, or no key at all. */
function normalizeCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim().length > 0);
}

/** Fix-site findings as a clean list — a lane may return junk or nothing. */
function normalizeFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((f) => f && typeof f === 'object' && !Array.isArray(f));
}

/**
 * Every lane's fix sites, in codeline order.
 *
 * NOT deduplicated by file: a shared vendored file legitimately needs the same change in
 * every codeline, and collapsing those to one entry would leave two writers with no
 * instruction. Each finding carries its own `codeline` (stamped by the spec pass), so a
 * consumer that wants one lane's sites filters on that.
 */
function concatFindings(perCodeline, codelineOrder) {
  const keys = Array.isArray(codelineOrder) && codelineOrder.length
    ? codelineOrder.filter((k) => Object.prototype.hasOwnProperty.call(perCodeline, k))
    : Object.keys(perCodeline);
  const out = [];
  for (const cl of keys) out.push(...normalizeFindings(perCodeline[cl]));
  return out;
}

/**
 * Union across lanes, first-seen order, deduped.
 *
 * Canonical describes the WHOLE story, which is verified only when every lane's criteria
 * hold — so the flat list is every lane's criteria, not one lane's. It stays a plain array
 * of strings because that is what every consumer of it reads: the TC writer, the team-lead
 * review, the repro-test writer, vc-coverage-check, claude.sh and the CPA sizing.
 */
function unionCriteria(perCodeline, codelineOrder) {
  const seen = new Set();
  const out = [];
  const keys = Array.isArray(codelineOrder) && codelineOrder.length
    ? codelineOrder.filter((k) => Object.prototype.hasOwnProperty.call(perCodeline, k))
    : Object.keys(perCodeline);
  for (const cl of keys) {
    for (const vc of normalizeCriteria(perCodeline[cl])) {
      if (seen.has(vc)) continue;
      seen.add(vc);
      out.push(vc);
    }
  }
  return out;
}

/**
 * Merge one lane's completed PRD into the canonical one, in place.
 *
 * @param {object}   opts.canonical  the canonical PRD (mutated)
 * @param {object}   opts.updated    the lane's own PRD after execution
 * @param {string}   opts.codeline   which codeline produced `updated`
 */
function mergeLaneIntoCanonical({ canonical, updated, codeline }) {
  const updatedStories = (updated && Array.isArray(updated.stories)) ? updated.stories : [];
  const byId = new Map(updatedStories.map((s) => [s.id, s]));

  canonical.stories = (canonical.stories || []).map((s) => {
    const u = byId.get(s.id);
    if (!u) return s;

    // A story confined to one codeline has exactly one author, so a wholesale merge is
    // right and always was.
    const spans = Array.isArray(s.codelines) && s.codelines.length > 1;
    if (!spans) return u;

    const perCodeline = {
      ...(s.perCodeline || {}),
      [codeline]: {
        status: u.status,
        completed: !!u.completed,
        completedAt: u.completedAt || null,
        reviewStatus: u.reviewStatus || null,
      },
    };

    // Each lane's criteria under its own key. A lane that produced none records an empty
    // list rather than deleting what other lanes already contributed — "this lane found
    // nothing to verify" and "this lane has not run" are different states, and blanking
    // the union on the first empty lane would lose every earlier lane's work.
    const vcPerCodeline = {
      ...(s.verificationCriteriaPerCodeline || {}),
      [codeline]: normalizeCriteria(u.verificationCriteria),
    };

    // Fix sites, same treatment and for the same reason: each lane found them in its own
    // checkout, and the finding shape carries a `codeline` so they stay attributable once
    // pooled.
    const fsPerCodeline = {
      ...(s.fixSiteAnalysisPerCodeline || {}),
      [codeline]: normalizeFindings(u.fixSiteAnalysis),
    };

    const everyLaneDone = s.codelines.every(
      (cl) => perCodeline[cl] && perCodeline[cl].completed === true,
    );

    return {
      ...u,
      perCodeline,
      verificationCriteriaPerCodeline: vcPerCodeline,
      verificationCriteria: unionCriteria(vcPerCodeline, s.codelines),
      fixSiteAnalysisPerCodeline: fsPerCodeline,
      fixSiteAnalysis: concatFindings(fsPerCodeline, s.codelines),
      codelines: s.codelines,
      completed: everyLaneDone,
      status: everyLaneDone ? 'completed' : 'in-progress',
      completedAt: everyLaneDone ? (u.completedAt || new Date().toISOString()) : null,
    };
  });

  // Stories CREATED during the run exist only in the codeline PRD, and a map over canonical
  // can never add them. The spec pass splits a story into <id>-impl / <id>-test there and
  // marks the parent deprecated — so without this, a run that implemented, tested, reviewed
  // and committed two child stories leaves canonical holding nothing but a deprecated
  // parent, and every reader concludes the run delivered nothing.
  const known = new Set(canonical.stories.map((s) => s.id));
  for (const u of updatedStories) {
    if (!known.has(u.id)) canonical.stories.push(u);
  }

  return canonical;
}

module.exports = {
  mergeLaneIntoCanonical, normalizeCriteria, unionCriteria, normalizeFindings, concatFindings,
};
