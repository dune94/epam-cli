/**
 * THE PLAN OF RECORD DECIDES WHAT THE PLAN IS — WRITTEN ONCE AT PAUSE 2, NEVER INFERRED FROM A SHAPE.
 *
 * Operator, 2026-10-14 (option 3): a criterion is the plan's when the plan approved at pause 2 has it — not when it
 * happens to be a string, and a criterion is "added by remediation" when the plan does not have it — not when it happens
 * to be exactly {text, status}. That shape guess was hard coding. The plan of record is written once, beside the lane's
 * pre-writer checkpoint, and never overwritten; a run paused before it existed derives it once from that checkpoint.
 *
 * EXECUTED: the real record_plan_of_record / plan_of_record_file (lib/plan-of-record.sh), the real story_acs_block, the
 * real retire-criteria.py, on a real checkpoint layout.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PLAN = 'the plan criterion';
const LATER = 'a criterion added after the pause';
const LANE = 'lib';

/** A project config dir with run R's lane checkpoint at <stage>, holding the plan's PRD. */
function estate(stage: string) {
  const d = mkdtempSync(join(tmpdir(), 'plan-of-record-')); dirs.push(d);
  const ck = join(d, 'runs/R/lanes', LANE, 'checkpoint'); mkdirSync(ck, { recursive: true });
  writeFileSync(join(ck, 'checkpoint.json'), JSON.stringify({ stage }));
  writeFileSync(join(ck, 'prd.json'), JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: [PLAN] }] }));
  // The line's working PRD: the plan's criterion, one added later with NO origin stamp (the old remediators' shape),
  // and one the PLAN wrote as an object (a shape the old guess would have taken for a remediation).
  const prd = join(d, 'line-prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: [PLAN, { text: LATER, status: 'pending' }] }] }));
  return { d, ck, prd };
}

const sh = (d: string, body: string) => spawnSync('bash', ['-c', `
  export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(d)} ORCH_RUN_ID=R EPAM_CODELINE=${LANE} EPAM_RELEASE_LINE=7.x
  . "${S}/lib/plan-of-record.sh"; . "${S}/lib/story-acs-block.sh"
  ${body}`], { encoding: 'utf8' });

describe('the plan of record', () => {
  it('is written once at pause 2 and never overwritten — the lane\'s file, even on a release line', () => {
    const e = estate('pre-writer');
    const r1 = sh(e.d, `record_plan_of_record "${join(e.ck, 'prd.json')}"; plan_of_record_file`);
    const f = r1.stdout.trim().split('\n').pop()!;
    expect(f, r1.stderr).toBe(join(e.ck, 'plan-of-record.json'));
    expect(JSON.parse(readFileSync(f, 'utf8')).stories[0].acceptanceCriteria).toEqual([PLAN]);
    sh(e.d, `record_plan_of_record "${e.prd}"`);   // a later PRD with more criteria
    expect(JSON.parse(readFileSync(f, 'utf8')).stories[0].acceptanceCriteria, 'the plan of record was overwritten').toEqual([PLAN]);
  });

  it('a run paused before it existed derives it once from its pre-writer checkpoint', () => {
    const e = estate('pre-writer');
    const r = sh(e.d, 'plan_of_record_ensured');
    expect(existsSync(join(e.ck, 'plan-of-record.json')), r.stderr).toBe(true);
  });

  it('NEGATIVE: never from a checkpoint before pause 2 — a post-spec checkpoint is not the approved plan', () => {
    const e = estate('post-spec');
    sh(e.d, 'plan_of_record_ensured');
    expect(existsSync(join(e.ck, 'plan-of-record.json'))).toBe(false);
  });
});

describe('what the plan is, decided by the plan of record', () => {
  it('the criteria block marks the criterion the plan does not have — and only that one', () => {
    const e = estate('pre-writer');
    const r = sh(e.d, `story_acs_block "${e.prd}" S`);
    expect(r.stdout, r.stderr).toMatch(new RegExp(`AC2: ${LATER}  \\[`));
    expect(r.stdout).toMatch(new RegExp(`AC1: ${PLAN}\\n`));
  });

  it('a criterion the plan does not have may be retired; the plan\'s never — whatever its shape', () => {
    const e = estate('pre-writer');
    // The plan itself wrote its criterion as an object this time: the old shape guess would have retired it.
    writeFileSync(join(e.ck, 'prd.json'), JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: [{ text: PLAN, status: 'pending' }] }] }));
    writeFileSync(e.prd, JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: [{ text: PLAN, status: 'pending' }, { text: LATER, status: 'pending' }] }] }));
    const fb = join(e.d, 'fb.json');
    writeFileSync(fb, JSON.stringify({ issues: [{ retireCriterion: PLAN }, { retireCriterion: LATER }] }));
    const r = sh(e.d, `plan_of_record_ensured >/dev/null; python3 "${S}/lib/handlers/retire-criteria.py" "${e.prd}" S "${fb}" "$(story_criterion_mark)" "$(plan_of_record_file)"`);
    expect(r.stdout.trim(), r.stderr).toBe('1');
    const texts = JSON.parse(readFileSync(e.prd, 'utf8')).stories[0].acceptanceCriteria.map((a: { text: string }) => a.text);
    expect(texts).toEqual([PLAN]);
  });

  it('NEGATIVE: with no plan of record, an unstamped criterion is not taken for a remediation — no shape guess', () => {
    const d = mkdtempSync(join(tmpdir(), 'no-plan-')); dirs.push(d);
    const prd = join(d, 'prd.json');
    writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S', acceptanceCriteria: [{ text: LATER, status: 'pending' }, { text: 'stamped', status: 'pending', origin: 'remediation' }] }] }));
    const r = sh(d, `story_acs_block "${prd}" S`);
    expect(r.stdout, r.stderr).toMatch(new RegExp(`AC1: ${LATER}\\n`));
    expect(r.stdout).toMatch(/AC2: stamped {2}\[/);
  });
});
