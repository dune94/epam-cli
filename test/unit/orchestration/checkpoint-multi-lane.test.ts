/**
 * THREE LANES, THREE CHECKPOINTS. The target has always been metrolinx: one story
 * spanning gotransit, upexpress and metrolinx.
 *
 * THE BUG (live, 2026-08-04, run 20260804T003327Z). checkpoint_dir() built
 * <project-config-dir>/runs/<run-id>/checkpoint — run id ONLY, no codeline. Every lane in
 * a run shares one ORCH_RUN_ID, so all three wrote to the same directory and each
 * overwrote the last. Two lanes reached pre-writer and paused correctly; lane 3's earlier
 * post-spec save then clobbered both. What remained was a stage marker from one lane
 * wearing another lane's PRD:
 *
 *     stage:     "post-spec"                    <- not pre-writer
 *     prd.json → outputDir: next.gotransit.com  <- a different lane
 *
 * Resuming that would have restored ONE lane's PRD into ALL THREE lanes, and skipped only
 * the spec pass because the surviving stage marker said post-spec.
 *
 * Every pause/resume test written before this one used a single ORCH_RUN_ID and a single
 * project dir. A defect that only appears at N>1 is invisible to a suite that only ever
 * tries N=1 — including under mutation testing, which re-runs those same single-lane
 * assertions. This file is the N>1 case.
 *
 * Same failure shape as project_parallel_lanes_shared_state: lanes inheriting one shared
 * path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const FLAGS = join(REPO_ROOT, 'orchestrations/scripts/lib/flags.sh');

/** The real metrolinx shape: one run id, one story, three codelines. */
const RUN_ID = '20260804T003327Z';
const LANES = ['gotransit', 'upexpress', 'metrolinx'] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'multi-lane-'));
  dirs.push(root);
  const projectDir = join(root, 'projects', 'demo');
  mkdirSync(projectDir, { recursive: true });
  return { root, projectDir };
}

/** Each lane gets its OWN filtered PRD, exactly as _filtered_prd() writes per lane. */
function lanePrd(root: string, lane: string): string {
  const p = join(root, `prd-${lane}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      project: {
        outputDir: `/repos/next.${lane}.com`,
        outputDirs: LANES.map((l) => ({ codeline: l, path: `/repos/next.${l}.com` })),
      },
      stories: [
        {
          id: 'AMSD-2041',
          title: 'spanning story',
          codelines: [...LANES],
          technicalNotes: { files: [`src/${lane}-only.ts`] },
        },
      ],
    }),
  );
  return p;
}

function sh(script: string, w: ReturnType<typeof workspace>, env: Record<string, string> = {}) {
  const r = spawnSync(
    'bash',
    ['-c', `set -uo pipefail\nsource ${JSON.stringify(FLAGS)}\nsource ${JSON.stringify(LIB)}\n${script}`],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: w.projectDir, ORCH_RUN_ID: RUN_ID, ...env },
    },
  );
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Save a checkpoint the way one lane of a real run does. */
function saveLane(w: ReturnType<typeof workspace>, lane: string, stage: string) {
  return sh(`save_run_checkpoint core ${stage}`, w, {
    PRD_FILE: lanePrd(w.root, lane),
    CODELINE_NAME: lane,
  });
}

function laneCheckpoint(w: ReturnType<typeof workspace>, lane: string) {
  const r = sh('checkpoint_dir', w, { CODELINE_NAME: lane });
  return r.out.trim().split('\n').pop() as string;
}

describe('each lane gets its own checkpoint directory', () => {
  it('REPRODUCES THE LIVE BUG: three lanes resolve to three DIFFERENT paths', () => {
    const w = workspace();
    const paths = LANES.map((l) => laneCheckpoint(w, l));
    expect(
      new Set(paths).size,
      `all lanes resolved to the same checkpoint path:\n  ${paths.join('\n  ')}\n` +
        'Every lane in a run shares one ORCH_RUN_ID, so they overwrite each other. Live ' +
        '2026-08-04: two lanes paused at pre-writer and lane 3 clobbered both.',
    ).toBe(LANES.length);
  });

  it('a lane checkpoint still lives under the run id, so a run stays one unit', () => {
    const w = workspace();
    for (const lane of LANES) {
      expect(laneCheckpoint(w, lane)).toContain(RUN_ID);
    }
  });

  it('the codeline name appears in the path, so it is inspectable by lane', () => {
    const w = workspace();
    for (const lane of LANES) {
      expect(laneCheckpoint(w, lane)).toContain(lane);
    }
  });
});

describe('lanes do not clobber each other', () => {
  it('all three saves survive — none is overwritten', () => {
    const w = workspace();
    for (const lane of LANES) expect(saveLane(w, lane, 'pre-writer').status).toBe(0);
    for (const lane of LANES) {
      expect(
        existsSync(join(laneCheckpoint(w, lane), 'prd.json')),
        `${lane}'s checkpoint is gone — a later lane overwrote it`,
      ).toBe(true);
    }
  });

  it('each lane keeps ITS OWN PRD, not a sibling\'s', () => {
    const w = workspace();
    for (const lane of LANES) saveLane(w, lane, 'pre-writer');
    for (const lane of LANES) {
      const prd = JSON.parse(readFileSync(join(laneCheckpoint(w, lane), 'prd.json'), 'utf8'));
      expect(
        prd.project.outputDir,
        `${lane}'s checkpoint holds a different lane's PRD — resuming would restore the ` +
          'wrong codeline into this lane',
      ).toBe(`/repos/next.${lane}.com`);
      expect(prd.stories[0].technicalNotes.files).toEqual([`src/${lane}-only.ts`]);
    }
  });

  it('a lane still at post-spec does NOT drag a sibling back from pre-writer', () => {
    const w = workspace();
    // The exact live sequence: two lanes reach pre-writer, a third saves post-spec after.
    saveLane(w, 'gotransit', 'pre-writer');
    saveLane(w, 'upexpress', 'pre-writer');
    saveLane(w, 'metrolinx', 'post-spec');

    for (const lane of ['gotransit', 'upexpress']) {
      const meta = JSON.parse(readFileSync(join(laneCheckpoint(w, lane), 'checkpoint.json'), 'utf8'));
      expect(
        meta.stage,
        `${lane} was pushed back to ${meta.stage} by another lane's save — its resume would ` +
          're-run the CPA and skill assessment it had already paid for',
      ).toBe('pre-writer');
    }
    const third = JSON.parse(readFileSync(join(laneCheckpoint(w, 'metrolinx'), 'checkpoint.json'), 'utf8'));
    expect(third.stage).toBe('post-spec');
  });
});

describe('resume is per lane', () => {
  it('restores each lane from its own checkpoint', () => {
    const w = workspace();
    for (const lane of LANES) saveLane(w, lane, 'pre-writer');

    for (const lane of LANES) {
      const live = lanePrd(w.root, lane);
      writeFileSync(live, JSON.stringify({ stories: [] })); // destroy the runtime PRD
      const r = sh(`restore_run_checkpoint ${RUN_ID}`, w, { PRD_FILE: live, CODELINE_NAME: lane });
      expect(r.status, `${lane} restore failed: ${r.out}`).toBe(0);
      const restored = JSON.parse(readFileSync(live, 'utf8'));
      expect(
        restored.project.outputDir,
        `${lane} was restored with another lane's PRD`,
      ).toBe(`/repos/next.${lane}.com`);
    }
  });

  it('derives skips from THIS lane\'s stage, not a sibling\'s', () => {
    const w = workspace();
    saveLane(w, 'gotransit', 'pre-writer');
    saveLane(w, 'metrolinx', 'post-spec');

    const go = sh(`resume_skip_env ${RUN_ID}`, w, { CODELINE_NAME: 'gotransit' });
    expect(go.out).toMatch(/SKIP_CPA=1/);

    const mx = sh(`resume_skip_env ${RUN_ID}`, w, { CODELINE_NAME: 'metrolinx' });
    expect(
      mx.out,
      'a post-spec lane was told to skip the CPA it never ran, because it read a sibling\'s stage',
    ).not.toMatch(/SKIP_CPA=1/);
  });

  it('refuses a lane that has no checkpoint, even when siblings do', () => {
    const w = workspace();
    saveLane(w, 'gotransit', 'pre-writer');
    const r = sh(`restore_run_checkpoint ${RUN_ID}`, w, {
      PRD_FILE: lanePrd(w.root, 'upexpress'),
      CODELINE_NAME: 'upexpress',
    });
    expect(
      r.status,
      'a lane with no checkpoint silently resumed on a sibling\'s artefacts',
    ).not.toBe(0);
  });
});

describe('single-lane behaviour is unchanged', () => {
  it('a run with no codeline still saves and restores', () => {
    const w = workspace();
    const prd = lanePrd(w.root, 'solo');
    expect(sh('save_run_checkpoint core pre-writer', w, { PRD_FILE: prd }).status).toBe(0);
    writeFileSync(prd, JSON.stringify({ stories: [] }));
    expect(sh(`restore_run_checkpoint ${RUN_ID}`, w, { PRD_FILE: prd }).status).toBe(0);
    expect(JSON.parse(readFileSync(prd, 'utf8')).stories[0].id).toBe('AMSD-2041');
  });

  it('list_run_checkpoints reports the run once, not once per lane', () => {
    const w = workspace();
    for (const lane of LANES) saveLane(w, lane, 'pre-writer');
    const ids = sh('list_run_checkpoints', w).out.trim().split('\n').filter(Boolean);
    expect(
      ids.filter((i) => i === RUN_ID).length,
      `the operator sees the run listed ${ids.length} times — one per lane`,
    ).toBe(1);
  });
});
