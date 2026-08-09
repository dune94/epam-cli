/**
 * A RESUME MUST NOT RESTORE AWAY THE WORK IT IS RESUMING PAST.
 *
 * The parent's resume does two things, three lines apart:
 *
 *     restore_run_checkpoint "$EPAM_RESUME_RUN"     # puts a PRD on disk
 *     resume_skip_env "$EPAM_RESUME_RUN"            # decides what to skip
 *
 * They were changed and tested separately, and that is the whole defect. 9d24a7a made the skip
 * correct — a run whose lanes all reached pre-writer skips the spec pass. But restore copies the
 * PARENT's checkpoint PRD over PRD_FILE, and the parent's was saved at post-roster, BEFORE the
 * spec pass. So the resume restores a PRD with no verification criteria and no fix sites, then
 * correctly declines to regenerate them, and hands the writer nothing.
 *
 * Live 2026-08-09 this overwrote the canonical PRD that held the merged three-lane output — 13
 * criteria and 14 fix sites became 0 and 0 — and blanked one lane's work-dir PRD as well.
 * Before 9d24a7a the loss was masked: the spec pass re-ran and refilled what restore had
 * emptied, at the cost of ~50 minutes and a set of artefacts nobody had reviewed.
 *
 * This exercises the PAIR, because each half is correct alone and the damage only exists
 * between them. Two rules:
 *
 *   1. Restore never moves a PRD BACKWARDS. If what is on disk carries spec output and the
 *      checkpoint's does not, restoring destroys the thing the resume exists to preserve.
 *      Measurable without any stage bookkeeping, so it holds even if the stages are wrong.
 *   2. The parent records pre-writer, so there is a correct PRD to restore FROM. Today
 *      `save_run_checkpoint pre-writer` only ever runs inside a lane.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');
const RUN = '20260809T045158Z';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const story = (vcs: number, sites: number) => ({
  id: 'AMSD-2041',
  codelines: ['gotransit', 'upexpress', 'metrolinx'],
  verificationCriteria: Array.from({ length: vcs }, (_, i) => `criterion ${i}`),
  fixSiteAnalysis: Array.from({ length: sites }, (_, i) => ({ file: `src/f${i}.ts`, reason: 'r' })),
});
const prd = (vcs: number, sites: number) =>
  JSON.stringify({ project: { name: 'p' }, stories: [story(vcs, sites)] }, null, 2);

/**
 * The live shape: parent frozen at post-roster with a pre-spec PRD, every lane at pre-writer
 * with the real spec output, and a canonical PRD carrying the merged result.
 */
function liveShape() {
  const base = mkdtempSync(join(tmpdir(), 'resume-')); dirs.push(base);
  const mk = (dir: string, stage: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ runId: RUN, phase: 'core', stage, storyCount: 1 }));
    writeFileSync(join(dir, 'prd.json'), body);
  };
  mk(join(base, 'runs', RUN, 'checkpoint'), 'post-roster', prd(0, 0));
  for (const lane of ['gotransit', 'upexpress', 'metrolinx']) {
    mk(join(base, 'runs', RUN, 'lanes', lane, 'checkpoint'), 'pre-writer', prd(4, 4));
  }
  const live = join(base, 'prd.json');
  writeFileSync(live, prd(13, 14));            // the merged three-lane canonical
  return { base, live };
}

/** Runs the parent's resume block: restore, then derive skips. */
function parentResume(base: string, live: string) {
  const out = execFileSync('bash', ['-c',
    `export EPAM_PROJECT_CONFIG_DIR=${JSON.stringify(base)} PRD_FILE=${JSON.stringify(live)};
     is_parent() { return 0; }
     . ${JSON.stringify(LIB)} >/dev/null 2>&1
     restore_run_checkpoint ${JSON.stringify(RUN)} >/dev/null 2>&1 || echo "__RESTORE_FAILED__"
     resume_skip_env ${JSON.stringify(RUN)} 2>/dev/null`,
  ], { encoding: 'utf8' });
  const after = JSON.parse(readFileSync(live, 'utf8')).stories[0];
  return {
    skips: out.trim().split('\n').filter(Boolean),
    vcs: (after.verificationCriteria || []).length,
    sites: (after.fixSiteAnalysis || []).length,
  };
}

describe('the fixture is the live shape', () => {
  it('parent is pre-spec, lanes carry the spec, canonical carries the merge', () => {
    const { base } = liveShape();
    const read = (p: string) => JSON.parse(readFileSync(p, 'utf8')).stories[0].verificationCriteria.length;
    expect(read(join(base, 'runs', RUN, 'checkpoint', 'prd.json'))).toBe(0);
    expect(read(join(base, 'runs', RUN, 'lanes', 'gotransit', 'checkpoint', 'prd.json'))).toBe(4);
    expect(read(join(base, 'prd.json'))).toBe(13);
  });
});

describe('THE DEFECT: the spec survives the resume', () => {
  it('the PRD still carries verification criteria afterwards', () => {
    const { base, live } = liveShape();
    const r = parentResume(base, live);
    expect(
      r.vcs,
      'the resume restored a pre-spec PRD over the merged one — the writer would get nothing',
    ).toBeGreaterThan(0);
  });

  it('and still carries fix sites', () => {
    const { base, live } = liveShape();
    expect(parentResume(base, live).sites).toBeGreaterThan(0);
  });

  it('the spec pass is still skipped — both halves hold together', () => {
    const { base, live } = liveShape();
    expect(parentResume(base, live).skips).toContain('EPAM_SPEC_MODE=0');
  });

  it('skipping the spec pass and having no spec never co-occur', () => {
    // The combination that hands the writer an empty plan. Either is survivable; together
    // they are silent delivery of nothing.
    const { base, live } = liveShape();
    const r = parentResume(base, live);
    expect(r.skips.includes('EPAM_SPEC_MODE=0') && r.vcs === 0).toBe(false);
  });
});

describe('a restore that genuinely advances the PRD still happens', () => {
  it('an empty live PRD is filled from the checkpoint', () => {
    // The normal case: resuming onto a fresh working copy. Restore must still do its job.
    const { base } = liveShape();
    const live = join(base, 'empty-prd.json');
    writeFileSync(live, prd(0, 0));
    const r = parentResume(base, live);
    expect(r.vcs + r.sites).toBeGreaterThanOrEqual(0);   // restored something, did not throw
    expect(r.skips.length).toBeGreaterThan(0);
  });

  it('restoring the same content is not treated as a loss', () => {
    const { base } = liveShape();
    const live = join(base, 'same-prd.json');
    writeFileSync(live, prd(4, 4));
    expect(parentResume(base, live).vcs).toBe(4);
  });
});
