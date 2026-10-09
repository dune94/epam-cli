'use strict';
/**
 * THE PLAN DECIDES THE CODELINES A STORY IS WORKED IN.
 *
 * Live AMSD-2974 run 1, 2026-10-09: discovery grounded four codelines; the AC gate's router picked one; the detective was
 * shown that one ("No other codeline is in scope for this investigation") and planned no consumer and no back-port. The
 * plan — written once, by the detective that reads the code — is the decision on which codelines change and which only
 * receive (operator, 2026-10-06); the router's pick is only where the story starts.
 *
 * Both answers come from the run's own record of what discovery grounded (codeline-facts.json: one top-level key per
 * codeline, each with its path, rewritten every run). Nothing is invented: a codeline the record does not hold is never
 * given a lane, and a lane the story already has is never taken away.
 */

/** The codelines discovery grounded this run, with their paths, in the record's order. */
function discovered(facts) {
  if (!facts || typeof facts !== 'object') return [];
  return Object.entries(facts)
    .filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && typeof v.path === 'string' && v.path)
    .map(([codeline, v]) => ({ codeline, path: v.path }));
}

function storyLanes(story) {
  return (Array.isArray(story && story.codelines) && story.codelines.length ? story.codelines : [story && story.codeline])
    .filter(Boolean);
}

/**
 * planScope(story, prd, facts) → { codelines, outputDirs }: what the detective writing the plan is shown — the story's
 * own codelines first, then every other codeline discovery grounded, each with where it is.
 */
function planScope(story, prd, facts) {
  const dirs = (prd && prd.project && Array.isArray(prd.project.outputDirs)) ? prd.project.outputDirs : [];
  const found = discovered(facts);
  const codelines = [...new Set([...storyLanes(story), ...found.map((f) => f.codeline)])];
  const outputDirs = codelines.map((cl) => dirs.find((d) => d && d.codeline === cl) || found.find((f) => f.codeline === cl))
    .filter(Boolean).map((d) => ({ codeline: d.codeline, path: d.path }));
  return { codelines, outputDirs };
}

/** Every codeline a plan names: its parts in plan order, then each package's provider and consumers. */
function plannedCodelines(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const parts = (Array.isArray(plan.codelines) ? plan.codelines : []).slice()
    .sort((a, b) => (Number(a && a.order) || 0) - (Number(b && b.order) || 0)).map((c) => c && c.codeline);
  const pkgs = Array.isArray(plan.packages) ? plan.packages : [];
  const around = pkgs.flatMap((p) => [p && p.providedBy, ...((p && Array.isArray(p.consumers)) ? p.consumers.map((c) => c && c.codeline) : [])]);
  return [...new Set([...parts, ...around].filter(Boolean))];
}

/**
 * adoptPlanCodelines(story, prd, facts) → the codelines added: every codeline the story's plan names that discovery
 * grounded becomes one of the story's codelines (story.codelines, routed one first) and one of the run's
 * project.outputDirs, with its path. Mutates story and prd.
 */
function adoptPlanCodelines(story, prd, facts) {
  if (!story || !story.overallPlan) return [];
  const found = discovered(facts);
  const have = storyLanes(story);
  const added = plannedCodelines(story.overallPlan)
    .filter((cl) => !have.includes(cl) && found.some((f) => f.codeline === cl));
  if (!added.length) return [];
  story.codelines = [...have, ...added];
  prd.project = prd.project || {};
  const dirs = Array.isArray(prd.project.outputDirs) ? prd.project.outputDirs : [];
  for (const cl of added) {
    if (!dirs.some((d) => d && d.codeline === cl)) dirs.push({ codeline: cl, path: found.find((f) => f.codeline === cl).path });
  }
  prd.project.outputDirs = dirs;
  return added;
}

module.exports = { planScope, adoptPlanCodelines, plannedCodelines, discovered };
