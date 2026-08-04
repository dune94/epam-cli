/**
 * engineSha MUST BE THE ENGINE'S SHA, WHATEVER DIRECTORY THE LANE IS STANDING IN.
 *
 * THE DEFECT, live run 20260804T152722Z. Three lanes paused and wrote a checkpoint each.
 * The engineSha they recorded:
 *
 *   gotransit   57a9b16    <- the engine. correct, by luck: saved from the repo's cwd
 *   upexpress   1f79748    <- next.upexpress.com's HEAD
 *   metrolinx   42b81c44   <- next.metrolinx.com's HEAD
 *
 * run-checkpoint.sh ran a bare `git rev-parse --short HEAD`, which resolves against the
 * CURRENT WORKING DIRECTORY. A worktree lane saves its checkpoint while cwd is the client
 * codeline, so two of three checkpoints recorded a commit from a completely different
 * repository — as a valid-looking short SHA, which is the worst kind of wrong.
 *
 * The field exists so a resume can tell whether the engine changed underneath a
 * checkpoint. Recording the client's SHA makes that judgement impossible, and confidently
 * so. Nothing reads it today, which is the only reason this cost nothing yet — a
 * write-only field that lies is a trap armed for whoever wires up the check.
 *
 * WHY NO TEST CAUGHT IT. Every existing checkpoint test runs with vitest's cwd already
 * inside this repository, so the bare `git` call happened to resolve correctly. The bug is
 * invisible unless the test STANDS SOMEWHERE ELSE. So these tests create a real second git
 * repo, cd into it, and run the real save — reproducing the live lane's conditions rather
 * than the test runner's.
 *
 * Generic: nothing here names a project, codeline or vendor. Costs no LLM tokens.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const CKPT = join(REPO_ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');

/** The engine's own HEAD — what engineSha must always be. */
function engineHead(): string {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
}

/** A real git repository standing in for a client codeline, with its OWN distinct HEAD. */
function makeForeignRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'file.txt'), 'a client codeline, not the engine\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'client baseline');
  return (git('rev-parse', '--short', 'HEAD').stdout || '').trim();
}

let work = '';
let foreign = '';
let foreignHead = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ckpt-sha-'));
  foreign = join(work, 'client-codeline');
  foreignHead = makeForeignRepo(foreign);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

/**
 * Run save_run_checkpoint FOR REAL, with cwd set wherever the caller says — exactly how a
 * worktree lane invokes it.
 */
function saveFrom(cwd: string, runId = 'RUN-1') {
  const cfg = join(work, `cfg-${runId}-${Math.abs(hash(cwd))}`);
  mkdirSync(cfg, { recursive: true });
  const prd = join(cfg, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'ST-1' }] }));

  const script = join(work, `save-${runId}.sh`);
  writeFileSync(
    script,
    [
      'set -uo pipefail',
      `source ${JSON.stringify(CKPT)}`,
      'save_run_checkpoint core pre-writer >/dev/null',
      'echo "EXIT:$?"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 20000,
    cwd,                                  // <- the whole point
    env: {
      ...process.env,
      EPAM_PROJECT_CONFIG_DIR: cfg,
      ORCH_RUN_ID: runId,
      PRD_FILE: prd,
      PHASE: 'core',
    },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const file = join(cfg, 'runs', runId, 'checkpoint', 'checkpoint.json');
  let meta: Record<string, unknown> | null = null;
  try {
    meta = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* left null — asserted below */ }
  return { out, meta };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe('the fixture is real (guard against a vacuous pass)', () => {
  it('the engine has a resolvable HEAD', () => {
    expect(engineHead()).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('the foreign repo is a DIFFERENT repository with a DIFFERENT HEAD', () => {
    expect(foreignHead).toMatch(/^[0-9a-f]{7,}$/);
    expect(
      foreignHead,
      'if the two repos shared a HEAD this test could not tell them apart',
    ).not.toBe(engineHead());
  });
});

describe('engineSha records the ENGINE, not whatever directory the lane is in', () => {
  it('THE LIVE DEFECT: saving from a client codeline records the ENGINE sha', () => {
    const { meta, out } = saveFrom(foreign, 'RUN-FOREIGN');
    expect(meta, `no checkpoint written:\n${out}`).not.toBeNull();
    expect(
      meta!.engineSha,
      'the checkpoint recorded the CLIENT repository\'s HEAD as the engine version. Live ' +
        '20260804T152722Z, two of three lanes did exactly this — a valid-looking short SHA ' +
        'from a completely different repository.',
    ).toBe(engineHead());
  });

  it('and specifically is NOT the foreign repo\'s HEAD', () => {
    const { meta } = saveFrom(foreign, 'RUN-FOREIGN-2');
    expect(meta!.engineSha).not.toBe(foreignHead);
  });

  it('saving from INSIDE the engine gives the same answer — one behaviour, not two', () => {
    const { meta } = saveFrom(REPO_ROOT, 'RUN-HOME');
    expect(meta!.engineSha).toBe(engineHead());
  });

  it('saving from a directory that is not a git repository AT ALL still records the engine', () => {
    const plain = join(work, 'not-a-repo');
    mkdirSync(plain, { recursive: true });
    const { meta } = saveFrom(plain, 'RUN-PLAIN');
    expect(
      meta!.engineSha,
      'outside any repository the bare call returns nothing and the field degrades to ' +
        '"unknown" — losing the provenance entirely',
    ).toBe(engineHead());
  });

  it('every lane saving from its OWN codeline agrees on the engine sha', () => {
    // Three distinct client repos, as three parallel lanes would be.
    const shas = ['a', 'b', 'c'].map((n, i) => {
      const d = join(work, `lane-${n}`);
      makeForeignRepo(d);
      return saveFrom(d, `RUN-LANE-${i}`).meta!.engineSha;
    });
    expect(new Set(shas).size, `lanes disagreed on the engine version: ${shas.join(', ')}`)
      .toBe(1);
    expect(shas[0]).toBe(engineHead());
  });
});

describe('the rest of the checkpoint metadata is unharmed', () => {
  it('createdAt is populated — it was never blank, contrary to an earlier claim of mine', () => {
    const { meta } = saveFrom(foreign, 'RUN-META');
    expect(
      meta!.createdAt,
      'I once reported this field as written-blank. It was not; I queried the wrong key ' +
        '(savedAt). Asserting it for real so neither of us has to take my word for it.',
    ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('runId, phase, stage and storyCount survive', () => {
    const { meta } = saveFrom(foreign, 'RUN-FIELDS');
    expect(meta!.runId).toBe('RUN-FIELDS');
    expect(meta!.phase).toBe('core');
    expect(meta!.stage).toBe('pre-writer');
    expect(meta!.storyCount).toBe(1);
  });
});
