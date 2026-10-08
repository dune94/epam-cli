/**
 * A STORY'S SPEC IS BUILT FROM THE PLAN IT HAS — A SPEC MADE UNDER ANOTHER PLAN, OR NONE, IS SPECIFIED AGAIN.
 *
 * Live AMSD-2974 runs 5-8 (2026-10-08): every lane resumed a spec approved on 10-01, before the story had its plan.
 * The plan gave upexpress no change while its criteria demanded upexpress-owned work: the reviewer rejected, the
 * writer was skipped, round after round. On 7.x the criteria asked for the whole fix while the fix sites prescribed a
 * narrow one, and the writer did the narrow one. Root cause: nothing recorded which plan a spec was built under.
 *
 * EXECUTED: the real handlers, the real lane-resume check (lib/run-checkpoint.sh lane_spec_is_current), the real
 * release-line pass (lib/release-lines.sh), and the spec pass's own stamp (spec-mode-runner.js stampSpecification).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'spec-plan-')); dirs.push(d); return d; };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planHash } = require(join(SCRIPTS, 'lib/plan-hash.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { specPredatesPlan } = require(join(SCRIPTS, 'lib/handlers/spec-predates-plan.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { storiesLackingSpec } = require(join(SCRIPTS, 'lib/handlers/stories-lacking-spec.js'));

const PLAN = { codelines: [{ codeline: 'lib', part: 'p', order: 1 }], packages: [{ package: '@s/l', providedBy: 'lib', releaseLines: [{ line: '1.x', base: 'v1', version: '1.0.1', onCodelineBase: false, carries: 'the whole change' }], consumers: [] }] };
const OTHER = { ...PLAN, codelines: [{ codeline: 'lib', part: 'another part', order: 1 }] };
const specified = (extra: object = {}) => ({ id: 'S-1', phase: 'core', status: 'pending', specification: { runId: 'r1', ...extra } });

describe('which stories\' spec predates the plan they have', () => {
  it('specified before the story had a plan, and it has one now', () => {
    expect(specPredatesPlan({ stories: [{ ...specified(), overallPlan: PLAN }] })).toEqual(['S-1']);
  });
  it('specified under another plan', () => {
    expect(specPredatesPlan({ stories: [{ ...specified({ planHash: planHash(OTHER) }), overallPlan: PLAN }] })).toEqual(['S-1']);
  });
  it('specified under the plan it has: current', () => {
    expect(specPredatesPlan({ stories: [{ ...specified({ planHash: planHash(PLAN) }), overallPlan: PLAN }] })).toEqual([]);
  });
  it('no plan at all: nothing to compare — current', () => {
    expect(specPredatesPlan({ stories: [specified()] })).toEqual([]);
  });
  it('a lane copy without the plan is judged against the canonical PRD\'s plan', () => {
    expect(specPredatesPlan({ stories: [specified()] }, { stories: [{ id: 'S-1', overallPlan: PLAN }] })).toEqual(['S-1']);
  });
  // Rehearsal 2026-10-08: a lane's checkpoint carries the plan it was specified under, so judged against its own copy
  // the spec always matched — the lane resumed "current" against a new plan. The run's plan is the canonical PRD's.
  it('a lane copy carrying an older plan is judged against the canonical PRD\'s current plan', () => {
    const lane = { stories: [{ ...specified({ planHash: planHash(OTHER) }), overallPlan: OTHER }] };
    expect(specPredatesPlan(lane, { stories: [{ id: 'S-1', overallPlan: PLAN }] })).toEqual(['S-1']);
    expect(specPredatesPlan(lane, { stories: [{ id: 'S-1', overallPlan: OTHER }] })).toEqual([]);
  });
  it('the hash is the plan\'s, not its key order', () => {
    expect(planHash(JSON.parse(JSON.stringify(PLAN)))).toBe(planHash({ packages: PLAN.packages, codelines: PLAN.codelines }));
    expect(planHash(PLAN)).not.toBe(planHash(OTHER));
  });
});

describe('the spec pass records the plan it built the spec under', () => {
  it('stampSpecification carries the plan\'s hash; no plan, no hash', () => {
    process.env.SPEC_MODE_NO_MAIN = '1';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const runner = require(join(SCRIPTS, 'spec-mode-runner.js'));
    expect(runner.stampSpecification({ id: 'S-1', overallPlan: PLAN }, { runId: 'r2' }).planHash).toBe(planHash(PLAN));
    expect(runner.stampSpecification({ id: 'S-1' }, { runId: 'r2' }).planHash).toBeUndefined();
    const stamped = { id: 'S-1', overallPlan: PLAN, status: 'pending', specification: runner.stampSpecification({ id: 'S-1', overallPlan: PLAN }, { runId: 'r2' }) };
    expect(specPredatesPlan({ stories: [stamped] }), 'a fresh spec would be specified again forever').toEqual([]);
  });
});

describe('a release line\'s spec pass includes a pending story whose spec predates the plan', () => {
  it('stories-lacking-spec names it', () => {
    expect(storiesLackingSpec({ implementationOrder: { core: ['S-1'] }, stories: [{ ...specified(), overallPlan: PLAN }] }, 'core')).toEqual(['S-1']);
    expect(storiesLackingSpec({ implementationOrder: { core: ['S-1'] }, stories: [{ ...specified({ planHash: planHash(PLAN) }), overallPlan: PLAN }] }, 'core')).toEqual([]);
  });
});

describe('a lane resumed from a checkpoint whose spec predates the plan is specified again', () => {
  function laneCurrent(ckPrd: object, canonicalPrd: object, workPrd: object = ckPrd) {
    const d = tmp();
    const ck = join(d, 'ck'); mkdirSync(ck);
    writeFileSync(join(ck, 'prd.json'), JSON.stringify(ckPrd));
    const work = join(d, 'work.json'); writeFileSync(work, JSON.stringify(workPrd));
    const canonical = join(d, 'canonical.json'); writeFileSync(canonical, JSON.stringify(canonicalPrd));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const digest = spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/spec-inputs-digest.js'), join(ROOT, 'orchestrations')], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(ck, 'checkpoint.json'), JSON.stringify({ stage: 'pre-writer', specInputsDigest: digest }));
    return spawnSync('bash', ['-c', `warning(){ echo "WARN $*"; }; log(){ :; }; info(){ :; }; error(){ :; }
NODE_BIN=${JSON.stringify(process.execPath)}; AUTOMATION_DIR=${JSON.stringify(join(ROOT, 'orchestrations'))}; SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
. ${JSON.stringify(join(SCRIPTS, 'lib/run-checkpoint.sh'))}
_prd_path=${JSON.stringify(canonical)} lane_spec_is_current ${JSON.stringify(ck)} ${JSON.stringify(work)} && echo CURRENT || echo AGAIN`], { encoding: 'utf8' });
  }
  it('spec from before the plan (completed or not): specified again, and says why', () => {
    const r = laneCurrent({ stories: [{ ...specified(), status: 'completed', completed: true }] }, { stories: [{ id: 'S-1', overallPlan: PLAN }] });
    expect(r.stdout, r.stderr).toMatch(/AGAIN/);
    expect(r.stdout).toMatch(/its spec was built before the story's plan/);
  });
  // Rehearsal 2026-10-08: cx-shared's lane work PRD held the story with NO spec (built from the canonical PRD while the
  // lane was declared passed); the lane judged that copy, found no spec "predating" anything, resumed it as current and
  // handed the writer a story with no files.
  it('the lane\'s working PRD holds a pending story with no spec at all: specified again', () => {
    const r = laneCurrent({ stories: [{ ...specified({ planHash: planHash(PLAN) }), overallPlan: PLAN }] }, { stories: [{ id: 'S-1', overallPlan: PLAN }] },
      { implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', phase: 'core', status: 'pending', overallPlan: PLAN }] });
    expect(r.stdout, r.stderr).toMatch(/AGAIN/);
  });
  it('spec built under the plan the story has: resumed as it is', () => {
    const r = laneCurrent({ stories: [{ ...specified({ planHash: planHash(PLAN) }), overallPlan: PLAN }] }, { stories: [{ id: 'S-1', overallPlan: PLAN }] });
    expect(r.stdout, r.stderr).toMatch(/CURRENT/);
  });
});

describe('a completed release line whose spec predates the plan is worked again in full — specified, written, reviewed', () => {
  it('rebuilt pending, with --reset, the spec pass on', () => {
    const d = tmp();
    const calls = join(d, 'calls.jsonl');
    const runner = join(d, 'runner.sh');
    writeFileSync(runner, `#!/bin/bash\n${JSON.stringify(process.execPath)} -e 'const p=require(process.env.PRD_FILE);process.stdout.write(JSON.stringify({args:process.argv.slice(1),spec:process.env.EPAM_SPEC_MODE||"",status:p.stories[0].status})+"\\n")' -- "$@" >> ${JSON.stringify(calls)}\n`);
    chmodSync(runner, 0o755);
    const lanePrd = join(d, 'lane.json');
    writeFileSync(lanePrd, JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ ...specified(), codeline: 'lib', status: 'completed', completed: true, overallPlan: PLAN }] }));
    const laneLog = join(d, 'lanes', 'lib'); mkdirSync(join(laneLog, 'lines', '1.x'), { recursive: true });
    writeFileSync(join(laneLog, 'lines', '1.x', 'prd.json'), JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ ...specified(), codeline: 'lib', status: 'completed', completed: true }] }));
    const r = spawnSync('bash', ['-c', `warning(){ echo "WARN $*"; }; log(){ echo "LOG $*"; }; info(){ :; }; error(){ echo "ERR $*"; }; success(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}
. ${JSON.stringify(join(SCRIPTS, 'lib/release-lines.sh'))}
_run_release_lines lib ${JSON.stringify(lanePrd)} /w/lib ${JSON.stringify(laneLog)} /dev/null "" ${JSON.stringify(runner)}`], { encoding: 'utf8', env: { ...process.env, EPAM_RESUME_RUN: 'r', LOG_DIR: d } });
    const rec = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    expect(rec.length, r.stdout + r.stderr).toBe(1);
    expect(rec[0].args).toContain('--reset');
    expect(rec[0].status).toBe('pending');
    expect(rec[0].spec).not.toBe('0');
  });
});
