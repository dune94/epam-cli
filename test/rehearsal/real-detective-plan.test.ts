/**
 * THE REAL DETECTIVE'S PLAN, JUDGED AGAINST THE CODELINES THEMSELVES — iterate the instructions on this, not on runs.
 *
 * Operator, 2026-10-06: "run a detective test — using real tokens and real prompts — to determine if this strategy
 * could work; I do not want to spend countless runs"; "get the proper detective generations in place and tested,
 * iteratively. Agentic 100% — no hard coding, guards, gates".
 *
 * WHAT RUNS: the engine's own runCodeGraphDetective on the real-estate copy's story (REHEARSAL_ROOT, built by
 * real-estate-setup.sh), on the real model through the provider set's own runner — one call per lane asked for.
 * The environment is loaded by the pipeline's own loaders (lib/env-file.sh), in the launcher's order.
 *
 * WHAT IS JUDGED, every fact derived from the codelines (manifests, git tags, paths), nothing about the ticket:
 *   - every fix site is a file of the codeline being worked;
 *   - the plan names every codeline of the story;
 *   - every consumer's declared range is its manifest's; the release it receives satisfies that range; each release
 *     line's base is an existing release of the provider;
 *   - a later lane, given the stored plan, writes no other plan and keeps its sites in its own codeline.
 * Test assertions only — nothing here runs in the pipeline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const R = process.env.REHEARSAL_ROOT || '';
const PROJECT = process.env.REHEARSAL_PROJECT || '';
const SET = process.env.REHEARSAL_PROVIDER_SET || '';
const LANES = (process.env.REHEARSAL_LANES || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = join(__dirname, '../../');
const ENGINE = join(ROOT, 'orchestrations/scripts');
const NODE = process.execPath;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const semver = require('semver');

function manifestOf(dir: string) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

/** One real detective call for a lane, through the engine, in the launcher's environment. */
function detect(lane: string, plan: unknown, journal: string) {
  const install = join(R, 'install');
  const proj = join(install, 'orchestrations/projects', PROJECT);
  const prd = JSON.parse(readFileSync(join(proj, 'prd.json'), 'utf8'));
  const root = (prd.project.outputDirs.find((d: { codeline: string }) => d.codeline === lane) || {}).path;
  const out = join(journal, lane); mkdirSync(out, { recursive: true });
  const probe = join(out, 'probe.js');
  writeFileSync(probe, `
const fs = require('fs'); const path = require('path');
const r = require(path.join(process.env.ENGINE, 'spec-mode-runner.js'));
(async () => {
  const prd = JSON.parse(fs.readFileSync(process.env.PRD_FILE, 'utf8'));
  const story = { ...prd.stories[0], codeline: process.env.LANE };
  delete story.overallPlan;
  const given = JSON.parse(process.env.GIVEN_PLAN || 'null'); if (given) story.overallPlan = given;
  const findings = await r.runCodeGraphDetective(story, process.env.LOG_DIR, {});
  fs.writeFileSync(path.join(process.env.LOG_DIR, 'result.json'), JSON.stringify({ findings, plan: story.overallPlan || null }, null, 2));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`);
  const script = `
cd ${JSON.stringify(ENGINE)}
export NODE_BIN=${JSON.stringify(NODE)} EPAM_PROVIDER_SET=${JSON.stringify(SET)}
. lib/env-file.sh
load_env_file_safe ${JSON.stringify(join(install, '.env'))} >/dev/null 2>&1
for f in ${JSON.stringify(join(install, 'orchestrations/jira'))}/*.env; do [ -f "$f" ] && load_env_file_safe "$f" preserve >/dev/null 2>&1; done
load_project_env ${JSON.stringify(proj)} preserve >/dev/null 2>&1 || exit 4
export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(proj)} PRD_FILE=${JSON.stringify(join(proj, 'prd.json'))} LOG_DIR=${JSON.stringify(out)} ENGINE=${JSON.stringify(ENGINE)} SPEC_MODE_NO_MAIN=1 EPAM_BROWNFIELD=1 PROJECT_ROOT=${JSON.stringify(root)} LANE=${JSON.stringify(lane)} SPEC_MODE_PROVIDER
exec "$NODE_BIN" ${JSON.stringify(probe)}`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, GIVEN_PLAN: plan ? JSON.stringify(plan) : '' }, timeout: 45 * 60_000 });
  writeFileSync(join(out, 'run.log'), `${r.stdout}\n${r.stderr}`);
  expect(r.status, `the detective did not run:\n${(r.stdout + r.stderr).slice(-1500)}`).toBe(0);
  expect(r.stdout + r.stderr, 'the call did not go through the provider set asked for').toMatch(new RegExp(`fast-path ${SET}/`));
  return { root: root as string, prd, ...JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')) };
}

/**
 * A LANE DOES ITS PART OF THE PLAN AND NO MORE. Where the plan gives this codeline no change of its own (it consumes the
 * change through a release), it has no fix site that requires one — the release does not exist until the provider ships it.
 * Seen on the real model, 2026-10-06: plan said none, and the lane prescribed its lock file and locale files.
 */
function beyondItsPart(lane: string, plan: any, findings: any[]) {
  const own = (plan && plan.packages || []).flatMap((p: any) => p.consumers || []).find((c: any) => c.codeline === lane);
  if (!own || !/^\s*none\b/i.test(String(own.change || ''))) return [];
  return (findings || []).filter((f) => f && f.changeRequired === true).map((f) => `${lane}: the plan gives it no change, yet ${f.file} is marked as requiring one`);
}

/** Every judgement the operator named, derived from the codelines. */
function judge(lane: string, res: { root: string; prd: any; findings: any[]; plan: any }) {
  const problems: string[] = [];
  const dirs = res.prd.project.outputDirs as Array<{ codeline: string; path: string }>;
  for (const f of res.findings || []) {
    const abs = isAbsolute(f.file) ? f.file : resolve(res.root, f.file);
    if (relative(res.root, abs).startsWith('..')) problems.push(`fix site outside ${lane}: ${f.file}`);
  }
  const plan = res.plan;
  if (!plan) { problems.push('no plan stored'); return problems; }
  const story = res.prd.stories[0];
  const named = new Set((plan.codelines || []).map((c: { codeline: string }) => c.codeline));
  for (const cl of story.codelines || [lane]) if (!named.has(cl)) problems.push(`plan omits codeline ${cl}`);
  for (const p of plan.packages || []) {
    const provider = dirs.find((d) => d.codeline === p.providedBy);
    const tags = provider ? execFileSync('git', ['-C', provider.path, 'tag'], { encoding: 'utf8' }).split('\n').filter(Boolean) : [];
    for (const l of p.releaseLines || []) if (!tags.includes(l.base)) problems.push(`release line ${l.line}: base ${l.base} is not a release of ${p.providedBy}`);
    for (const c of p.consumers || []) {
      const d = dirs.find((x) => x.codeline === c.codeline);
      const m = d ? manifestOf(d.path) : null;
      const declared = m && ({ ...(m.dependencies || {}), ...(m.devDependencies || {}), ...(m.peerDependencies || {}) })[p.package];
      if (declared !== c.declaredRange) problems.push(`${c.codeline}: plan says ${c.declaredRange}, manifest declares ${declared}`);
      if (declared && semver.valid(c.receivesVia) && !semver.satisfies(c.receivesVia, declared)) problems.push(`${c.codeline}: receives ${c.receivesVia}, outside its range ${declared}`);
      if (!semver.valid(c.receivesVia)) problems.push(`${c.codeline}: receives "${c.receivesVia}", not a version`);
      if (!(p.releaseLines || []).some((l: { version: string }) => l.version === c.receivesVia)) problems.push(`${c.codeline}: receives ${c.receivesVia}, which no release line ships`);
    }
  }
  return problems;
}

describe.runIf(R && PROJECT && SET && LANES.length)('the real detective writes the story\'s plan, and every lane is worked from it', () => {
  const journal = join(R, 'journal', `detective-${new Date().toISOString().replace(/[:.]/g, '')}`);
  let stored: unknown = null;

  it(`the first lane (${LANES[0]}) writes the plan, its fix sites its own`, () => {
    const res = detect(LANES[0], null, journal);
    const problems = judge(LANES[0], res);
    writeFileSync(join(journal, `${LANES[0]}-judged.json`), JSON.stringify({ problems, plan: res.plan, findings: res.findings }, null, 2));
    stored = res.plan;
    expect(problems).toEqual([]);
  }, 50 * 60_000);

  for (const lane of LANES.slice(1)) {
    it(`a later lane (${lane}) is given that plan, writes no other, and keeps its sites in its own codeline`, () => {
      expect(stored, 'the first lane stored no plan — nothing to give').toBeTruthy();
      const res = detect(lane, stored, journal);
      const problems = judge(lane, res);
      if (JSON.stringify(res.plan) !== JSON.stringify(stored)) problems.push('the later lane replaced the plan');
      problems.push(...beyondItsPart(lane, stored, res.findings));
      writeFileSync(join(journal, `${lane}-judged.json`), JSON.stringify({ problems, findings: res.findings }, null, 2));
      expect(problems).toEqual([]);
    }, 50 * 60_000);
  }
});

describe.runIf(!(R && PROJECT && SET && LANES.length))('the real-detective test', () => {
  it('is opt-in: REHEARSAL_ROOT, REHEARSAL_PROJECT, REHEARSAL_PROVIDER_SET and REHEARSAL_LANES name what it runs', () => {
    expect(existsSync(ENGINE)).toBe(true);
  });
});
