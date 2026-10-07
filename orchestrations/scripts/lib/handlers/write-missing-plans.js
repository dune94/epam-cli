#!/usr/bin/env node
/**
 * write-missing-plans.js <canonical-prd> — a story specified before it had a plan gets its plan.
 *
 * The story's plan (detective-overall-plan) is written by its first detective during the spec pass. A story already
 * specified before plans existed is never specified again on a resume, so no detective writes one and no release line
 * the plan would name can ever run (the £0 rehearsal of AMSD-2974, 2026-10-06). Operator, 2026-10-06: such a story
 * gets its plan — the detective's plan only: its fix sites, criteria and every other field are left as they are.
 *
 * Which stories: every story with no plan — the plan comes first, before any lane, so every codeline and every release
 * line is worked from it (a resume's canonical PRD may carry no spec output at all: it lives in the lanes' checkpoints).
 * A story with a plan keeps it. The detective runs as the spec pass runs it, for the story's first codeline, able to
 * read every codeline of the story. A detective that cannot answer leaves no plan and says so — the run goes on.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const prdFile = process.argv[2];
const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
const dirs = (prd.project && Array.isArray(prd.project.outputDirs)) ? prd.project.outputDirs : [];

// A STORY IS PLANNED ONCE PER RUN. A resume restores the canonical PRD from the run's checkpoint, which never held the
// plan; asked again, the detective answered differently (AMSD-2974, 2026-10-07). The plan a run wrote is kept under the
// run and is the plan on every later launch of it.
const cfg = process.env.EPAM_PROJECT_CONFIG_DIR || process.env.PROJECT_CONFIG_DIR || '';
const run = process.env.EPAM_RESUME_RUN || process.env.ORCH_RUN_ID || '';
const keptDir = cfg && run ? path.join(cfg, 'runs', run, 'plans') : '';
const keptFile = (id) => (keptDir ? path.join(keptDir, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`) : '');
const keep = (s) => {
  const f = keptFile(s.id);
  if (!f || fs.existsSync(f)) return;
  fs.mkdirSync(keptDir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s.overallPlan, null, 2));
};
let restored = false;
for (const s of prd.stories || []) {
  if (!s) continue;
  if (s.overallPlan) { keep(s); continue; }
  const f = keptFile(s.id);
  if (f && fs.existsSync(f)) {
    s.overallPlan = JSON.parse(fs.readFileSync(f, 'utf8'));
    restored = true;
    process.stderr.write(`[plan] ${s.id}: the plan this run wrote is kept — ${f}\n`);
  }
}
if (restored) fs.writeFileSync(prdFile, JSON.stringify(prd, null, 2));
const wanting = (prd.stories || []).filter((s) => s && !s.overallPlan);
if (!wanting.length) process.exit(0);

process.env.SPEC_MODE_NO_MAIN = '1';
// eslint-disable-next-line global-require
const runner = require(path.join(__dirname, '..', '..', 'spec-mode-runner.js'));

(async () => {
  let changed = false;
  for (const s of wanting) {
    const first = (Array.isArray(s.codelines) && s.codelines[0]) || s.codeline;
    const root = (dirs.find((d) => d && d.codeline === first) || {}).path || prd.project.outputDir || '';
    const probe = { ...s, codeline: first };
    delete probe.overallPlan;
    const prevRoot = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = root;
    try {
      await runner.runCodeGraphDetective(probe, process.env.LOG_DIR || '', { prd });
    } catch (e) {
      process.stderr.write(`[plan] ${s.id}: the detective did not answer (${(e && e.message) || e})\n`);
    } finally {
      if (prevRoot === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = prevRoot;
    }
    if (probe.overallPlan) {
      s.overallPlan = probe.overallPlan;
      keep(s);
      changed = true;
      process.stderr.write(`[plan] ${s.id}: plan written (${probe.overallPlan.codelines.length} codeline(s), `
        + `${(probe.overallPlan.packages || []).reduce((n, p) => n + (p.releaseLines || []).length, 0)} release line(s))\n`);
    } else {
      process.stderr.write(`[plan] ${s.id}: no plan — the detective gave none; this story's release lines cannot be known\n`);
    }
  }
  if (changed) fs.writeFileSync(prdFile, JSON.stringify(prd, null, 2));
})().catch((e) => { process.stderr.write(`[plan] could not write plans: ${(e && e.stack) || e}\n`); process.exit(0); });
