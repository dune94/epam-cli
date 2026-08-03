/**
 * The pause/resume blocks in run-agent-orchestration.sh are EXECUTED here, not grepped.
 *
 * Both blocks are extracted verbatim from the orchestrator and run against real files, so
 * this fails if the wiring is deleted, reordered, or made conditional on something else —
 * which a `toMatch(/EPAM_PAUSE_AFTER_SPEC/)` assertion would not.
 *
 * The invariants that matter:
 *  - the checkpoint is saved WHETHER OR NOT we pause (un-persisted output is a violation)
 *  - pausing exits 0 and prints the run number the operator needs to resume
 *  - resuming skips the spec pass (EPAM_SPEC_MODE=0) instead of re-deriving it
 *  - a resume that cannot be honoured HALTS rather than running against stale state
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/run-checkpoint.sh');
const FLAGS = join(REPO_ROOT, 'orchestrations/scripts/lib/flags.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Slice the real block out of the orchestrator between two anchors. */
function block(startAnchor: string, endAnchor: string): string {
  const i = orchSrc.indexOf(startAnchor);
  expect(i, `anchor not found in the orchestrator: ${startAnchor}`).toBeGreaterThan(-1);
  const j = orchSrc.indexOf(endAnchor, i);
  expect(j, `end anchor not found: ${endAnchor}`).toBeGreaterThan(i);
  return orchSrc.slice(i, j);
}

const RESUME_BLOCK = () => block('if [ -n "${EPAM_RESUME_RUN:-}" ]; then', 'if [ "$DRY_RUN" = true ]');
const PAUSE_BLOCK = () =>
  block('if _ckpt_path=$(save_run_checkpoint', 'exit 0\nfi') + 'exit 0\nfi\n';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'pauseres-'));
  dirs.push(root);
  const projectDir = join(root, 'projects', 'demo');
  const logDir = join(root, 'logs');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const prd = join(root, 'prd.json');
  writeFileSync(
    prd,
    JSON.stringify({ project: { name: 'demo' }, stories: [{ id: 'ST-1', title: 'T' }] }),
  );
  return { root, projectDir, logDir, prd };
}

function runBlock(body: string, w: ReturnType<typeof workspace>, extra: Record<string, string> = {}) {
  const script = join(w.root, `blk-${Math.abs(body.length)}.sh`);
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      'GREEN=""; NC=""; RED=""',
      'info(){ echo "[info] $*"; }; warning(){ echo "[warn] $*"; }',
      'error(){ echo "[error] $*" >&2; }; success(){ echo "[ok] $*"; }',
      'step_emit(){ :; }',
      `source ${JSON.stringify(FLAGS)}`,
      `source ${JSON.stringify(LIB)}`,
      body,
      'echo "REACHED_IMPLEMENTATION spec_mode=${EPAM_SPEC_MODE:-1}' +
        ' skip_cpa=${SKIP_CPA:-0} skip_skill=${SKIP_SKILL_ASSESSMENT:-0}"',
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      EPAM_PROJECT_CONFIG_DIR: w.projectDir,
      PRD_FILE: w.prd,
      LOG_DIR: w.logDir,
      PHASE: 'core',
      ORCH_RUN_ID: '20260803T120000Z',
      ...extra,
    },
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('the checkpoint is saved regardless of pausing', () => {
  it('saves even when NOT pausing — un-persisted spec output is the violation', () => {
    const w = workspace();
    const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: '' });
    expect(
      existsSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json')),
      'a normal run left the spec pass output un-persisted',
    ).toBe(true);
    expect(r.out, 'a non-paused run must continue into implementation').toContain(
      'REACHED_IMPLEMENTATION',
    );
  });

  it('a failed save warns loudly and does not silently continue as if resumable', () => {
    const w = workspace();
    const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PROJECT_CONFIG_DIR: '' });
    expect(r.out).toMatch(/could not save|NOT be resumable/i);
  });
});

describe('pausing stops before implementation and reports the run number', () => {
  it('exits 0 and never reaches implementation', () => {
    const w = workspace();
    const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: '1' });
    expect(r.status).toBe(0);
    expect(r.out, 'the run continued into implementation despite the pause').not.toContain(
      'REACHED_IMPLEMENTATION',
    );
  });

  it('prints the RUN NUMBER the operator needs', () => {
    const w = workspace();
    const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: '1' });
    expect(r.out).toContain('20260803T120000Z');
    expect(r.out).toMatch(/RUN NUMBER/i);
  });

  it('tells the operator exactly how to resume', () => {
    const w = workspace();
    const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: '1' });
    expect(r.out).toContain('EPAM_RESUME_RUN=20260803T120000Z');
  });

  it('accepts any truthy spelling of the flag, not just "1"', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE']) {
      const w = workspace();
      const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: v });
      expect(r.out, `EPAM_PAUSE_AFTER_SPEC=${v} did not pause`).not.toContain(
        'REACHED_IMPLEMENTATION',
      );
    }
  });

  it('does NOT pause when the flag is unset or falsey', () => {
    for (const v of ['', '0', 'false', 'no']) {
      const w = workspace();
      const r = runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: v });
      expect(r.out, `EPAM_PAUSE_AFTER_SPEC=${v} paused when it should not`).toContain(
        'REACHED_IMPLEMENTATION',
      );
    }
  });
});

describe('resuming starts at implementation, not at the beginning', () => {
  function withCheckpoint() {
    const w = workspace();
    runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: '1' });
    return w;
  }

  it('skips the spec pass by forcing EPAM_SPEC_MODE=0', () => {
    const w = withCheckpoint();
    const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '20260803T120000Z' });
    expect(r.status).toBe(0);
    expect(
      r.out,
      'the resume did not disable the spec pass, so the expensive stage would run again',
    ).toContain('spec_mode=0');
  });

  it('reaches implementation', () => {
    const w = withCheckpoint();
    const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '20260803T120000Z' });
    expect(r.out).toContain('REACHED_IMPLEMENTATION');
  });

  it('restores the persisted PRD over whatever is on disk', () => {
    const w = withCheckpoint();
    writeFileSync(w.prd, JSON.stringify({ stories: [] }));
    runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '20260803T120000Z' });
    expect(JSON.parse(readFileSync(w.prd, 'utf8')).stories[0].id).toBe('ST-1');
  });

  it('is repeatable — the same run can be resumed more than once', () => {
    const w = withCheckpoint();
    for (const attempt of [1, 2, 3]) {
      writeFileSync(w.prd, JSON.stringify({ stories: [] }));
      const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '20260803T120000Z' });
      expect(r.status, `resume ${attempt} failed`).toBe(0);
      expect(JSON.parse(readFileSync(w.prd, 'utf8')).stories[0].id).toBe('ST-1');
    }
  });

  it('does nothing when EPAM_RESUME_RUN is unset — a normal run is unaffected', () => {
    const w = withCheckpoint();
    const r = runBlock(RESUME_BLOCK(), w, {});
    expect(r.out).toContain('REACHED_IMPLEMENTATION');
    expect(r.out, 'a normal run must still do its spec pass').toContain('spec_mode=1');
    expect(r.out).toContain('skip_cpa=0');
  });

  /**
   * THE RECEIVER, NOT THE CALLER. resume_skip_env producing the right assignments proves
   * nothing if the orchestrator does not APPLY them. A mutation that replaced the call
   * with a hardcoded EPAM_SPEC_MODE=0 passed every test until these were added.
   */
  it('a post-spec resume skips the spec pass but NOT the CPA', () => {
    const w = workspace();
    const script = join(w.root, 'mk-post.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash', 'set -uo pipefail',
      `source ${JSON.stringify(FLAGS)}`, `source ${JSON.stringify(LIB)}`,
      'save_run_checkpoint core post-spec >/dev/null',
    ].join('\n'));
    spawnSync('bash', [script], {
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: w.projectDir, PRD_FILE: w.prd,
             LOG_DIR: w.logDir, ORCH_RUN_ID: '20260803T120000Z' }, encoding: 'utf8' });

    const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '20260803T120000Z' });
    expect(r.out).toContain('spec_mode=0');
    expect(r.out, 'a post-spec resume skipped the CPA, which it never actually ran')
      .toContain('skip_cpa=0');
  });

  it('a PRE-WRITER resume also skips the CPA and the skill assessment', () => {
    const w = workspace();
    const script = join(w.root, 'mk-pre.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash', 'set -uo pipefail',
      `source ${JSON.stringify(FLAGS)}`, `source ${JSON.stringify(LIB)}`,
      'save_run_checkpoint core pre-writer >/dev/null',
    ].join('\n'));
    spawnSync('bash', [script], {
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: w.projectDir, PRD_FILE: w.prd,
             LOG_DIR: w.logDir, ORCH_RUN_ID: '20260803T120000Z' }, encoding: 'utf8' });

    const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '20260803T120000Z' });
    expect(r.out).toContain('spec_mode=0');
    expect(
      r.out,
      're-running the CPA throws away most of what pausing before the writer bought',
    ).toContain('skip_cpa=1');
    expect(r.out).toContain('skip_skill=1');
  });
});

/**
 * The PRE-WRITER pause, executed. This is the more useful stop: the spec pass, CPA, skill
 * assessment and detective have all run, so everything the writer consumes is settled and
 * inspectable — but no code has been generated yet.
 */
describe('the pre-writer pause stops before any story is written', () => {
  const PRE_WRITER_BLOCK = () =>
    block('if _ckpt_path=$(save_run_checkpoint "$PHASE" pre-writer', 'exit 0\n        fi') +
    'exit 0\n        fi\n';

  function runPreWriter(w: ReturnType<typeof workspace>, extra: Record<string, string> = {}) {
    const script = join(w.root, `pw-${Object.keys(extra).join('')}.sh`);
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        'GREEN=""; NC=""; RED=""',
        'info(){ echo "[info] $*"; }; warning(){ echo "[warn] $*"; }',
        'error(){ echo "[error] $*" >&2; }; success(){ echo "[ok] $*"; }',
        'step_emit(){ :; }',
        'non_review_main="ST-1"',
        `source ${JSON.stringify(FLAGS)}`,
        `source ${JSON.stringify(LIB)}`,
        PRE_WRITER_BLOCK(),
        'echo "WRITER_STARTED"',
      ].join('\n'),
    );
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        EPAM_PROJECT_CONFIG_DIR: w.projectDir,
        PRD_FILE: w.prd,
        LOG_DIR: w.logDir,
        PHASE: 'core',
        ORCH_RUN_ID: '20260803T120000Z',
        ...extra,
      },
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  }

  it('EPAM_PAUSE_AT=pre-writer stops before the writer runs', () => {
    const w = workspace();
    const r = runPreWriter(w, { EPAM_PAUSE_AT: 'pre-writer' });
    expect(r.status).toBe(0);
    expect(r.out, 'the writer ran despite the pre-writer pause').not.toContain('WRITER_STARTED');
  });

  it('prints the run number and the resume command', () => {
    const w = workspace();
    const r = runPreWriter(w, { EPAM_PAUSE_AT: 'pre-writer' });
    expect(r.out).toMatch(/RUN NUMBER/i);
    expect(r.out).toContain('EPAM_RESUME_RUN=20260803T120000Z');
  });

  it('records the checkpoint AS pre-writer, so a resume skips the CPA too', () => {
    const w = workspace();
    runPreWriter(w, { EPAM_PAUSE_AT: 'pre-writer' });
    const meta = JSON.parse(
      readFileSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'checkpoint.json'), 'utf8'),
    );
    expect(meta.stage).toBe('pre-writer');
  });

  it('saves the checkpoint even when NOT pausing, and lets the writer run', () => {
    const w = workspace();
    const r = runPreWriter(w);
    expect(r.out, 'a normal run must reach the writer').toContain('WRITER_STARTED');
    expect(
      existsSync(join(w.projectDir, 'runs', '20260803T120000Z', 'checkpoint', 'prd.json')),
      'the pre-writer inputs were never persisted on a normal run',
    ).toBe(true);
  });

  it('EPAM_PAUSE_AT=spec does NOT stop here — it would never reach the writer', () => {
    const w = workspace();
    const r = runPreWriter(w, { EPAM_PAUSE_AT: 'spec' });
    expect(r.out).toContain('WRITER_STARTED');
  });
});

describe('an un-honourable resume HALTS', () => {
  it('exits non-zero on an unknown run id rather than running on stale state', () => {
    const w = workspace();
    const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '19990101T000000Z' });
    expect(r.status, 'an unknown run id was silently ignored and the run continued').not.toBe(0);
    expect(r.out).not.toContain('REACHED_IMPLEMENTATION');
  });

  it('names the checkpoints that DO exist, so the operator can correct the id', () => {
    const w = workspace();
    runBlock(PAUSE_BLOCK(), w, { EPAM_PAUSE_AFTER_SPEC: '1' });
    const r = runBlock(RESUME_BLOCK(), w, { EPAM_RESUME_RUN: '19990101T000000Z' });
    expect(r.out).toContain('20260803T120000Z');
  });
});
