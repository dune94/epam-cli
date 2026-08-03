/**
 * Pause points are NAMED STAGES, not a growing pile of boolean flags.
 *
 * The first pause landed after the spec pass. That is the cheapest place to stop, but it
 * is not the most useful one: between the spec pass and the writer the pipeline still runs
 * the CPA pre-pass, the skill assessment, the detective and the TC writer — and everything
 * the WRITER consumes is only settled at the end of all that. Stopping just before the
 * writer is what lets its inputs be inspected before any code is generated.
 *
 * So the control is EPAM_PAUSE_AT=<stage>:
 *   spec        — after the specification pass (the original behaviour)
 *   pre-writer  — after CPA / skill assessment / detective, before any story is written
 *
 * A resume must skip everything the checkpoint already paid for, which depends on WHICH
 * stage it was taken at. Resuming a pre-writer checkpoint and then re-running the CPA and
 * skill assessment would throw away most of what the pause was for.
 *
 * EPAM_PAUSE_AFTER_SPEC=1 keeps working — it is already proven on a live run, and silently
 * breaking it would be worse than the duplication.
 *
 * Everything here EXECUTES the real bash. No source-text greps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const FLAGS = join(REPO_ROOT, 'orchestrations/scripts/lib/flags.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'pause-stage-'));
  dirs.push(root);
  const projectDir = join(root, 'projects', 'demo');
  mkdirSync(projectDir, { recursive: true });
  const prd = join(root, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'ST-1', title: 'T' }] }));
  return { root, projectDir, prd };
}

function sh(script: string, w: ReturnType<typeof workspace>, env: Record<string, string> = {}) {
  const r = spawnSync(
    'bash',
    ['-c', `set -uo pipefail\nsource ${JSON.stringify(FLAGS)}\nsource ${JSON.stringify(LIB)}\n${script}`],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        EPAM_PROJECT_CONFIG_DIR: w.projectDir,
        PRD_FILE: w.prd,
        ORCH_RUN_ID: '20260803T120000Z',
        ...env,
      },
    },
  );
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const meta = (w: ReturnType<typeof workspace>) =>
  JSON.parse(
    readFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'checkpoint.json'), 'utf8'),
  );

describe('a checkpoint records WHICH stage it was taken at', () => {
  it('defaults to the post-spec stage', () => {
    const w = workspace();
    expect(sh('save_run_checkpoint core', w).status).toBe(0);
    expect(meta(w).stage).toBe('post-spec');
  });

  it('records pre-writer when saved there', () => {
    const w = workspace();
    expect(sh('save_run_checkpoint core pre-writer', w).status).toBe(0);
    expect(
      meta(w).stage,
      'without the stage a resume cannot know how much work the checkpoint already paid for',
    ).toBe('pre-writer');
  });
});

describe('should_pause_at — which stage stops the run', () => {
  const w = () => workspace();

  it('EPAM_PAUSE_AT=spec pauses at spec, not at pre-writer', () => {
    const ws = w();
    expect(sh('should_pause_at spec && echo STOP || echo GO', ws, { EPAM_PAUSE_AT: 'spec' }).out)
      .toContain('STOP');
    expect(sh('should_pause_at pre-writer && echo STOP || echo GO', ws, { EPAM_PAUSE_AT: 'spec' }).out)
      .toContain('GO');
  });

  it('EPAM_PAUSE_AT=pre-writer pauses before the writer, not at spec', () => {
    const ws = w();
    expect(sh('should_pause_at pre-writer && echo STOP || echo GO', ws, { EPAM_PAUSE_AT: 'pre-writer' }).out)
      .toContain('STOP');
    expect(
      sh('should_pause_at spec && echo STOP || echo GO', ws, { EPAM_PAUSE_AT: 'pre-writer' }).out,
      'pausing before the writer must NOT also stop at the spec pass — that would never reach the writer',
    ).toContain('GO');
  });

  it('unset means never pause — a normal run is unaffected', () => {
    const ws = w();
    for (const stage of ['spec', 'pre-writer']) {
      expect(sh(`should_pause_at ${stage} && echo STOP || echo GO`, ws).out).toContain('GO');
    }
  });

  it('BACK-COMPAT: EPAM_PAUSE_AFTER_SPEC=1 still pauses at spec', () => {
    const ws = w();
    expect(
      sh('should_pause_at spec && echo STOP || echo GO', ws, { EPAM_PAUSE_AFTER_SPEC: '1' }).out,
      'the already-proven flag was silently broken',
    ).toContain('STOP');
  });

  it('BACK-COMPAT: the old flag accepts any truthy spelling', () => {
    const ws = w();
    for (const v of ['1', 'true', 'yes', 'ON']) {
      expect(sh('should_pause_at spec && echo STOP || echo GO', ws, { EPAM_PAUSE_AFTER_SPEC: v }).out)
        .toContain('STOP');
    }
  });

  it('an unknown stage name never pauses — a typo must not silently stop the pipeline', () => {
    const ws = w();
    expect(
      sh('should_pause_at spec && echo STOP || echo GO', ws, { EPAM_PAUSE_AT: 'sepc' }).out,
      'a misspelled stage silently changed behaviour somewhere',
    ).toContain('GO');
  });

  it('rejects an unrecognised EPAM_PAUSE_AT loudly rather than ignoring it', () => {
    const ws = w();
    const r = sh('should_pause_at spec; echo "rc=$?"', ws, { EPAM_PAUSE_AT: 'nonsense' });
    expect(
      r.out,
      'a typo in EPAM_PAUSE_AT must be reported — silently never pausing is how an ' +
        'operator waits forever for a pause that will not come',
    ).toMatch(/unknown pause stage|nonsense/i);
  });
});

describe('a resume skips exactly what its checkpoint already paid for', () => {
  it('a post-spec checkpoint skips the spec pass only', () => {
    const w = workspace();
    sh('save_run_checkpoint core post-spec', w);
    const r = sh('resume_skip_env 20260803T120000Z', w);
    expect(r.out).toMatch(/EPAM_SPEC_MODE=0/);
    expect(
      r.out,
      'a post-spec resume must still run the CPA — that work was never done',
    ).not.toMatch(/SKIP_CPA=1/);
  });

  it('a pre-writer checkpoint skips the spec pass, the CPA and the skill assessment', () => {
    const w = workspace();
    sh('save_run_checkpoint core pre-writer', w);
    const r = sh('resume_skip_env 20260803T120000Z', w);
    expect(r.out).toMatch(/EPAM_SPEC_MODE=0/);
    expect(
      r.out,
      're-running the CPA throws away most of what pausing before the writer bought',
    ).toMatch(/SKIP_CPA=1/);
    expect(r.out).toMatch(/SKIP_SKILL_ASSESSMENT=1/);
  });

  it('refuses to emit anything for a checkpoint that does not exist', () => {
    const w = workspace();
    const r = sh('resume_skip_env 19990101T000000Z', w);
    expect(r.status).not.toBe(0);
  });

  it('an unrecognised recorded stage fails loudly rather than guessing the skips', () => {
    const w = workspace();
    sh('save_run_checkpoint core post-spec', w);
    const f = join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'checkpoint.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    m.stage = 'from-the-future';
    writeFileSync(f, JSON.stringify(m));
    const r = sh('resume_skip_env 20260803T120000Z', w);
    expect(
      r.status,
      'guessing which steps to skip risks silently re-running or silently skipping real work',
    ).not.toBe(0);
  });
});

describe('the pre-writer checkpoint captures what the writer will consume', () => {
  it('saves the PRD as it stands at the pre-writer point, not the post-spec one', () => {
    const w = workspace();
    sh('save_run_checkpoint core post-spec', w);
    // Simulate the CPA/detective enriching the PRD after the spec pass.
    writeFileSync(
      w.prd,
      JSON.stringify({
        stories: [{ id: 'ST-1', title: 'T', fixSiteAnalysis: { cause: 'real' }, effort: 3 }],
      }),
    );
    sh('save_run_checkpoint core pre-writer', w);
    const saved = JSON.parse(
      readFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'), 'utf8'),
    );
    expect(
      saved.stories[0].fixSiteAnalysis,
      'the pre-writer checkpoint kept a stale post-spec PRD — the detective work was lost',
    ).toBeTruthy();
    expect(meta(w).stage).toBe('pre-writer');
  });

  it('overwriting an earlier checkpoint in the same run is allowed and updates the stage', () => {
    const w = workspace();
    sh('save_run_checkpoint core post-spec', w);
    expect(meta(w).stage).toBe('post-spec');
    sh('save_run_checkpoint core pre-writer', w);
    expect(meta(w).stage).toBe('pre-writer');
    expect(existsSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json'))).toBe(true);
  });
});
