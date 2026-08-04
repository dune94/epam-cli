/**
 * PAUSE AND RESUME, EXERCISED END TO END, ACROSS THREE REAL LANES IN THREE REAL REPOS.
 *
 * The engineSha defect (live run 20260804T152722Z) was invisible to every existing
 * checkpoint test for one reason: they all ran with vitest's cwd already inside this
 * repository, so a bare `git rev-parse` happened to resolve correctly. The bug only exists
 * when the caller is standing somewhere else — which is exactly what a worktree lane does,
 * and exactly what no test did.
 *
 * That is the gap this file closes. It does not stub git, does not stub the filesystem, and
 * does not hand-author a checkpoint. It builds three real git repositories, runs the REAL
 * save from inside each one the way a lane does, then runs the REAL restore and the REAL
 * resume-env derivation on what landed on disk. Every link is the shipped code.
 *
 * Integration, not unit: the unit test proves the SHA is right; this proves the whole
 * pause→resume cycle still works once it is, and that a checkpoint written from a foreign
 * cwd is genuinely resumable rather than merely well-formed.
 *
 * Costs no LLM tokens and no network — "live" here means the real scripts against a real
 * multi-repo layout, which is where the defect lived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../');
const CKPT = join(REPO_ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const RUN_ID = 'ITEST-RUN-1';
const LANES = ['lane-alpha', 'lane-beta', 'lane-gamma'];

const engineHead = () =>
  (spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
    .stdout || '').trim();

let work = '';
const laneRepo: Record<string, string> = {};
const laneHead: Record<string, string> = {};
const laneCfg: Record<string, string> = {};

/** A real git repo per lane, each with its own distinct HEAD — as the codelines are. */
function buildLane(name: string) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  // Distinct content -> distinct SHA per lane.
  writeFileSync(join(dir, 'README.md'), `codeline ${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', `baseline ${name}`);
  laneRepo[name] = dir;
  laneHead[name] = (git('rev-parse', '--short', 'HEAD').stdout || '').trim();

  // Each lane gets its own project config dir, as the orchestrator gives it.
  const cfg = join(work, `cfg-${name}`);
  mkdirSync(cfg, { recursive: true });
  laneCfg[name] = cfg;
}

/** Run a snippet with run-checkpoint.sh sourced, from a given cwd and lane env. */
function inLane(name: string, body: string[], extraEnv: Record<string, string> = {}) {
  const script = join(work, `s-${name}-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, ['set -uo pipefail', `source ${JSON.stringify(CKPT)}`, ...body].join('\n'));
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: laneRepo[name],                 // the lane stands in its own codeline
    env: {
      ...process.env,
      EPAM_PROJECT_CONFIG_DIR: laneCfg[name],
      ORCH_RUN_ID: RUN_ID,
      PHASE: 'core',
      ...extraEnv,
    },
  });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

/** The PRD a lane's spec pass would have settled — distinct per lane, so mix-ups show. */
function writeLanePrd(name: string): string {
  const prd = join(laneCfg[name], 'prd.json');
  writeFileSync(prd, JSON.stringify({
    stories: [{
      id: 'ST-1',
      title: `work for ${name}`,
      technicalNotes: { files: [`src/${name}.ts`] },
      verificationCriteria: [`the behaviour described for ${name} is observable`],
      vcResolution: 'partial',
    }],
  }, null, 2));
  return prd;
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ckpt-itest-'));
  LANES.forEach(buildLane);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the multi-repo fixture is real (guard against a vacuous pass)', () => {
  it('three lanes, three DIFFERENT repositories, none of them the engine', () => {
    const heads = LANES.map((l) => laneHead[l]);
    expect(new Set(heads).size, 'lanes must have distinct HEADs or mix-ups are invisible').toBe(3);
    for (const h of heads) expect(h).not.toBe(engineHead());
  });
});

describe('PAUSE: every lane saves a checkpoint from inside its own codeline', () => {
  const saved: Record<string, Record<string, unknown>> = {};

  it('all three saves succeed', () => {
    for (const lane of LANES) {
      const prd = writeLanePrd(lane);
      const { out } = inLane(lane, ['save_run_checkpoint core pre-writer'], { PRD_FILE: prd });
      const file = join(laneCfg[lane], 'runs', RUN_ID, 'checkpoint', 'checkpoint.json');
      expect(existsSync(file), `${lane} wrote no checkpoint:\n${out}`).toBe(true);
      saved[lane] = JSON.parse(readFileSync(file, 'utf8'));
    }
  });

  it('THE LIVE DEFECT: every lane records the ENGINE sha, not its own codeline\'s', () => {
    for (const lane of LANES) {
      expect(
        saved[lane].engineSha,
        `${lane} recorded ${saved[lane].engineSha} — its own repo's HEAD is ${laneHead[lane]}. ` +
          'Live 20260804T152722Z, two of three lanes stored a client SHA as the engine version.',
      ).toBe(engineHead());
      expect(saved[lane].engineSha).not.toBe(laneHead[lane]);
    }
  });

  it('all three lanes agree on one engine version', () => {
    expect(new Set(LANES.map((l) => saved[l].engineSha)).size).toBe(1);
  });

  it('the stage and story count are recorded per lane', () => {
    for (const lane of LANES) {
      expect(saved[lane].stage).toBe('pre-writer');
      expect(saved[lane].storyCount).toBe(1);
      expect(saved[lane].runId).toBe(RUN_ID);
    }
  });

  it('each lane\'s PRD is its OWN — no cross-lane clobbering', () => {
    for (const lane of LANES) {
      const p = JSON.parse(
        readFileSync(join(laneCfg[lane], 'runs', RUN_ID, 'checkpoint', 'prd.json'), 'utf8'),
      );
      expect(p.stories[0].title).toBe(`work for ${lane}`);
      expect(p.stories[0].technicalNotes.files[0]).toBe(`src/${lane}.ts`);
    }
  });

  it('the spec pass output a resume needs is inside the checkpoint — VCs survive', () => {
    const p = JSON.parse(
      readFileSync(join(laneCfg[LANES[0]], 'runs', RUN_ID, 'checkpoint', 'prd.json'), 'utf8'),
    );
    expect(p.stories[0].verificationCriteria).toHaveLength(1);
    expect(p.stories[0].vcResolution).toBe('partial');
  });
});

describe('RESUME: what was saved is actually restorable', () => {
  it('restore_run_checkpoint succeeds for every lane, by its REAL exit code', () => {
    for (const lane of LANES) {
      const target = join(work, `restored-${lane}.json`);
      // The exit status of restore itself — an earlier version of this test captured the
      // status of a trailing `echo`, which is always 0 and asserts nothing.
      const { out } = inLane(
        lane,
        [`restore_run_checkpoint ${JSON.stringify(RUN_ID)} >/dev/null 2>&1; echo "RC=$?"`],
        { PRD_FILE: target },
      );
      expect(out, `${lane}: restore reported no exit code`).toMatch(/RC=\d+/);
      expect(Number((out.match(/RC=(\d+)/) as RegExpMatchArray)[1]), `${lane} restore failed`).toBe(0);
      expect(existsSync(target), `${lane}: restore returned 0 but wrote no PRD`).toBe(true);
    }
  });

  it('the restored PRD is the lane\'s own settled spec, with its VCs intact', () => {
    for (const lane of LANES) {
      const target = join(work, `restored2-${lane}.json`);
      inLane(lane, [`restore_run_checkpoint ${JSON.stringify(RUN_ID)} >/dev/null 2>&1`],
        { PRD_FILE: target });
      // No conditional skip: a missing file is a failure, not a reason to pass quietly.
      expect(existsSync(target), `${lane}: nothing was restored`).toBe(true);
      const restored = JSON.parse(readFileSync(target, 'utf8'));
      expect(restored.stories[0].title).toBe(`work for ${lane}`);
      expect(restored.stories[0].technicalNotes.files[0]).toBe(`src/${lane}.ts`);
      expect(restored.stories[0].verificationCriteria).toHaveLength(1);
    }
  });

  it('a checkpoint with an EMPTY PRD is refused — validate before writing', () => {
    const lane = LANES[0];
    const bad = join(laneCfg[lane], 'runs', 'BAD-RUN', 'checkpoint');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'prd.json'), JSON.stringify({ stories: [] }));
    writeFileSync(join(bad, 'checkpoint.json'), JSON.stringify({ stage: 'pre-writer' }));
    const target = join(work, 'must-not-be-touched.json');
    writeFileSync(target, '{"stories":[{"id":"ORIGINAL"}]}');
    const { out } = inLane(
      lane,
      ['restore_run_checkpoint BAD-RUN >/dev/null 2>&1; echo "RC=$?"'],
      { PRD_FILE: target },
    );
    expect(Number((out.match(/RC=(\d+)/) as RegExpMatchArray)[1]), 'an empty PRD was accepted')
      .not.toBe(0);
    expect(
      JSON.parse(readFileSync(target, 'utf8')).stories[0].id,
      'a REJECTED checkpoint overwrote the live PRD — half-restored state is worse than none',
    ).toBe('ORIGINAL');
  });

  it('the resume env skips the spec pass, and says so explicitly', () => {
    const { out } = inLane(LANES[0], [`resume_skip_env ${JSON.stringify(RUN_ID)}`]);
    expect(
      out,
      'a resume that re-runs the spec pass would discard the very work the checkpoint paid for',
    ).toMatch(/EPAM_SPEC_MODE=0/);
  });

  it('a pre-writer resume also skips CPA and skill assessment — the stage decides', () => {
    const { out } = inLane(LANES[0], [`resume_skip_env ${JSON.stringify(RUN_ID)}`]);
    expect(out).toMatch(/SKIP_CPA=1/);
    expect(out).toMatch(/SKIP_SKILL_ASSESSMENT=1/);
  });

  it('an unknown run id fails loudly rather than resuming from nothing', () => {
    const { out, status } = inLane(
      LANES[0],
      ['if resume_skip_env NO-SUCH-RUN >/dev/null 2>&1; then echo "WRONGLY_OK"; else echo "REFUSED"; fi'],
    );
    expect(out).toMatch(/REFUSED/);
    expect(out).not.toMatch(/WRONGLY_OK/);
    expect(status).toBe(0);
  });
});
