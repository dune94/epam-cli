/**
 * Pause after spec pass, resume at implementation — the checkpoint must be REAL.
 *
 * The spec pass is the expensive, slow half of a run (~50 min observed, ~12 agent calls,
 * and until recently it emitted no cost lines at all). Today a run that reaches
 * implementation and fails must redo all of it, because the spec pass mutates the runtime
 * PRD in place and `pre-run-reset.sh` clears the log tree at the START of every launch.
 * There is nothing durable to resume FROM.
 *
 * Standing rule this implements: "IF SOMETHING IS CURRENTLY GENERATED AND NOT SAVED TO
 * DISC — that violates this entire project." So the checkpoint is written at the moment
 * the artefacts settle, to a location teardown cannot reach.
 *
 * Every test here EXECUTES the real bash functions against real files. Nothing greps
 * source text — see CLAUDE.md, "Test the code AND the impact of the code".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Env {
  [k: string]: string;
}

/** Run bash with the real library sourced. */
function sh(script: string, env: Env = {}) {
  const r = spawnSync('bash', ['-c', `set -uo pipefail\nsource ${JSON.stringify(LIB)}\n${script}`], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout || ''}`, err: `${r.stderr || ''}` };
}

/** A workspace with a runtime PRD + profiles, and a project config dir. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'ckpt-'));
  dirs.push(root);
  const projectDir = join(root, 'projects', 'demo');
  const logDir = join(root, 'logs');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const prd = join(root, 'prd.json');
  writeFileSync(
    prd,
    JSON.stringify({
      project: { name: 'demo' },
      stories: [
        {
          id: 'ST-1',
          title: 'A story',
          codeline: 'alpha',
          technicalNotes: {
            files: ['src/a.ts'],
            perCodeline: { alpha: { files: ['src/a.ts'] } },
          },
          testCriteria: { facts: ['VC one', 'VC two'] },
        },
      ],
    }),
  );
  const profiles = join(root, 'profiles.json');
  writeFileSync(profiles, JSON.stringify({ agents: { 'story-writer': { model: 'x' } } }));

  return { root, projectDir, logDir, prd, profiles };
}

function env(w: ReturnType<typeof workspace>, extra: Env = {}): Env {
  return {
    EPAM_PROJECT_CONFIG_DIR: w.projectDir,
    PRD_FILE: w.prd,
    AGENT_PROFILES_FILE: w.profiles,
    LOG_DIR: w.logDir,
    ORCH_RUN_ID: '20260803T120000Z',
    ...extra,
  };
}

describe('a checkpoint is actually written to disk', () => {
  it('save_run_checkpoint creates the checkpoint and reports its path', () => {
    const w = workspace();
    const r = sh('save_run_checkpoint core', env(w));
    expect(r.status, `save failed: ${r.err}`).toBe(0);
    const dir = join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint');
    expect(existsSync(dir), 'no checkpoint directory was created').toBe(true);
  });

  it('persists the POST-spec-pass PRD, not a stale copy', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    const saved = join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json');
    expect(existsSync(saved)).toBe(true);
    const prd = JSON.parse(readFileSync(saved, 'utf8'));
    expect(prd.stories[0].id).toBe('ST-1');
  });

  it('persists the MANIFEST — including the per-codeline resolution', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    const prd = JSON.parse(
      readFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'), 'utf8'),
    );
    expect(prd.stories[0].technicalNotes.files).toEqual(['src/a.ts']);
    expect(
      prd.stories[0].technicalNotes.perCodeline,
      'the per-codeline manifest is the expensive part of the spec pass and must survive',
    ).toBeTruthy();
  });

  it('persists the VCs', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    const prd = JSON.parse(
      readFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'), 'utf8'),
    );
    expect(prd.stories[0].testCriteria.facts).toEqual(['VC one', 'VC two']);
  });

  it('persists the agent profiles', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    const p = join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'profiles.json');
    expect(existsSync(p), 'profiles decide which model each agent gets — resume needs them').toBe(true);
  });

  it('records what this checkpoint IS, so a resume can be validated', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    const meta = JSON.parse(
      readFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'checkpoint.json'), 'utf8'),
    );
    expect(meta.runId).toBe('20260803T120000Z');
    expect(meta.phase).toBe('core');
    expect(meta.stage, 'a checkpoint must say WHERE in the pipeline it was taken').toBe('post-spec');
    expect(String(meta.createdAt || '')).not.toBe('');
  });
});

/**
 * THE WHOLE POINT. A checkpoint under LOG_DIR would be erased by pre-run-reset.sh at the
 * start of the very next launch — which is how the only successful run's evidence was
 * destroyed on 2026-08-03.
 */
describe('the checkpoint survives teardown', () => {
  it('is NOT written under LOG_DIR', () => {
    const w = workspace();
    const r = sh('save_run_checkpoint core && checkpoint_dir', env(w));
    const path = r.out.trim().split('\n').pop() as string;
    expect(
      path.startsWith(w.logDir),
      `checkpoint at ${path} is inside LOG_DIR and pre-run-reset would erase it`,
    ).toBe(false);
  });

  it('still exists after LOG_DIR is wiped entirely', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    rmSync(w.logDir, { recursive: true, force: true }); // simulate pre-run-reset
    const dir = join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json');
    expect(existsSync(dir), 'the checkpoint did not survive a log wipe').toBe(true);
  });
});

describe('resume restores exactly what was saved', () => {
  it('restore_run_checkpoint puts the PRD back', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    writeFileSync(w.prd, JSON.stringify({ stories: [] })); // runtime PRD destroyed
    const r = sh('restore_run_checkpoint 20260803T120000Z', env(w));
    expect(r.status, `restore failed: ${r.err}`).toBe(0);
    const prd = JSON.parse(readFileSync(w.prd, 'utf8'));
    expect(prd.stories[0].id, 'the PRD was not restored').toBe('ST-1');
    expect(prd.stories[0].technicalNotes.perCodeline).toBeTruthy();
  });

  it('restores the profiles too', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    writeFileSync(w.profiles, '{}');
    sh('restore_run_checkpoint 20260803T120000Z', env(w));
    expect(JSON.parse(readFileSync(w.profiles, 'utf8')).agents).toBeTruthy();
  });

  it('is repeatable — resuming twice from the same checkpoint both work', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    for (const attempt of [1, 2]) {
      writeFileSync(w.prd, JSON.stringify({ stories: [] }));
      const r = sh('restore_run_checkpoint 20260803T120000Z', env(w));
      expect(r.status, `resume attempt ${attempt} failed: ${r.err}`).toBe(0);
      expect(JSON.parse(readFileSync(w.prd, 'utf8')).stories[0].id).toBe('ST-1');
    }
  });
});

/** No silent failure: a bad resume must stop the run, never proceed on stale state. */
describe('a resume that cannot be honoured fails loudly', () => {
  it('refuses an unknown run id', () => {
    const w = workspace();
    const r = sh('restore_run_checkpoint 19990101T000000Z', env(w));
    expect(r.status, 'an unknown run id silently succeeded').not.toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/no checkpoint|not found/i);
  });

  it('refuses a checkpoint whose PRD is missing', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    rmSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'));
    const r = sh('restore_run_checkpoint 20260803T120000Z', env(w));
    expect(r.status, 'a partial checkpoint was accepted').not.toBe(0);
  });

  it('refuses a checkpoint whose PRD is not valid JSON', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    writeFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'), '{oops');
    const r = sh('restore_run_checkpoint 20260803T120000Z', env(w));
    expect(r.status, 'a corrupt checkpoint was accepted').not.toBe(0);
  });

  it('does NOT overwrite the runtime PRD when the checkpoint is rejected', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    writeFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'), '{oops');
    writeFileSync(w.prd, JSON.stringify({ marker: 'untouched' }));
    sh('restore_run_checkpoint 20260803T120000Z', env(w));
    expect(
      JSON.parse(readFileSync(w.prd, 'utf8')).marker,
      'a rejected restore still clobbered the live PRD',
    ).toBe('untouched');
  });
});

describe('the run number is discoverable', () => {
  it('list_run_checkpoints reports saved runs', () => {
    const w = workspace();
    sh('save_run_checkpoint core', env(w));
    const r = sh('list_run_checkpoints', env(w));
    expect(r.out).toContain('20260803T120000Z');
  });

  it('reports nothing (and does not error) when no checkpoint exists', () => {
    const w = workspace();
    const r = sh('list_run_checkpoints', env(w));
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe('');
  });
});
