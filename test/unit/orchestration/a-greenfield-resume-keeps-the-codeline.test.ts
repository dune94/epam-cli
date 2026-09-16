/**
 * A GREENFIELD RESUME KEEPS THE CODELINE, THE PRD AND THE RUN.
 *
 * Every greenfield "resume" of run 20260915T101555Z (2.0.38 → 2.0.41) began with
 *   [tier3] Tearing down output directory: …/regintel-build
 *   [tier3] Output directory clean (deleted and reinitialised)
 * because the generic launcher has no notion of EPAM_RESUME_RUN: `if GREENFIELD=1` restores the
 * authored PRD, deletes the output directory and runs every declared phase with --reset. The
 * orchestrator underneath then restored its checkpoint — into a codeline that no longer existed.
 * A completed, verified story was rebuilt from nothing on each resume and read as "first ever";
 * the spec pass re-ran and re-rolled its split ids because the canonical PRD carries no spec; the
 * run's trail was never continuous. The £0 greenfield cell launched and finished; it never resumed,
 * so it never saw any of it.
 *
 * This EXECUTES the real launcher (tier3-run.sh) with EPAM_RESUME_RUN set, against a project
 * fixture and stand-ins for the binaries it invokes — the orchestrator records how it was called —
 * and asserts, on disk, what a resume must preserve. The fresh-launch behaviour is asserted too, so
 * the fix cannot be "never tear down".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LAUNCHER = join(ROOT, 'orchestrations/scripts/tier3-run.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/** A greenfield project on disk, a codeline the previous phase built, and a launcher invocation. */
function launch(opts: { resume?: string; pauseAt?: string }) {
  const ws = mkdtempSync(join(tmpdir(), 'gf-resume-')); dirs.push(ws);
  const projects = join(ws, 'projects'); const proj = join(projects, 'demo'); mkdirSync(proj, { recursive: true });
  const out = join(ws, 'build'); mkdirSync(out, { recursive: true });
  const bins = join(ws, 'bins'); mkdirSync(bins);
  const record = join(ws, 'calls.txt'); writeFileSync(record, '');
  // The authored PRD and the runtime PRD: the runtime one carries what the run has done so far.
  writeFileSync(join(proj, 'prd.authored.json'), JSON.stringify({ project: { name: 'demo' }, stories: [{ id: 'S-1', status: 'pending', completed: false }, { id: 'S-2', status: 'pending', completed: false }] }));
  const prd = join(ws, 'demo-prd.json');
  writeFileSync(prd, JSON.stringify({ project: { name: 'demo' }, stories: [{ id: 'S-1', status: 'completed', completed: true, specification: { runId: 'R1' } }, { id: 'S-2', status: 'pending', completed: false, specification: { runId: 'R1' } }] }));
  writeFileSync(join(proj, 'config.env'), [
    'EPAM_BROWNFIELD=0', `OUTPUT_DIR=${out}`, 'EPAM_PHASES="scaffold core"', `PRD_FILE=${prd}`, `PRD_CANONICAL=${join(proj, 'prd.authored.json')}`,
    'EPAM_PROMPT_PROVISION_MODE=copy', 'EPAM_PROVIDER_SET=mockserver',
  ].join('\n'));
  // The codeline the previous phase built and committed.
  spawnSync('git', ['-C', out, 'init', '-q']);
  mkdirSync(join(out, 'src'), { recursive: true }); writeFileSync(join(out, 'src', 'app.py'), 'print("built by the scaffold phase")\n');
  spawnSync('git', ['-C', out, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  spawnSync('git', ['-C', out, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'scaffold']);
  const head = spawnSync('git', ['-C', out, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  // Stand-ins: each records its argv; the orchestrator records which phase and flags it got.
  stub(bins, 'orch.sh', [
    `echo "orch $* RESUME=\${EPAM_RESUME_RUN:-}" >> "${record}"`,
    // A pause, as the real orchestrator records it: the run id and the stage, then exit 0.
    `if [ -n "\${PAUSE_AT_PHASE:-}" ] && [ "$2" = "\$PAUSE_AT_PHASE" ]; then mkdir -p "\${EPAM_PROJECT_OUTPUT_DIR:-${ws}/logs}"; printf '{"runId":"20260916T200051Z","stage":"post-roster","phase":"%s"}' "$2" > "\${EPAM_PROJECT_OUTPUT_DIR:-${ws}/logs}/paused-run.json"; echo "  RUN NUMBER: 20260916T200051Z"; fi`,
    'exit 0',
  ].join('\n'));
  stub(bins, 'rem.sh', `echo "rem $*" >> "${record}"; exit 0`);
  stub(bins, 'preflight.sh', `echo "preflight $*" >> "${record}"; exit 0`);
  stub(bins, 'reset.sh', `echo "reset $*" >> "${record}"; echo PRE_RUN_RESET_STATE_CLEARED; exit 0`);
  const r = spawnSync('bash', [LAUNCHER, '--project', 'demo', '--yes'], {
    encoding: 'utf8', cwd: ws, timeout: 120_000,
    env: {
      ...process.env, EPAM_PROJECTS_DIR: projects, EPAM_ORCHESTRATOR_BIN: join(bins, 'orch.sh'), EPAM_PRD_REMEDIATE_BIN: join(bins, 'rem.sh'),
      EPAM_PREFLIGHT_BIN: join(bins, 'preflight.sh'), PRE_RUN_RESET_SCRIPT: join(bins, 'reset.sh'),
      EPAM_FREE_RUN: '1', EPAM_PROJECT_OUTPUT_DIR: join(ws, 'logs'), ...(opts.pauseAt ? { PAUSE_AT_PHASE: opts.pauseAt } : {}),
      ...(opts.resume ? { EPAM_RESUME_RUN: opts.resume } : { EPAM_RESUME_RUN: '' }),
    },
  });
  return { r, out, prd, head, calls: () => readFileSync(record, 'utf8'), log: `${r.stdout}\n${r.stderr}` };
}

describe('a greenfield resume keeps the codeline, the PRD and the run', () => {
  it('a FRESH launch still rebuilds the codeline and restores the authored PRD — the fix is not "never tear down"', () => {
    const t = launch({});
    expect(t.log).toMatch(/Tearing down output directory/);
    expect(existsSync(join(t.out, 'src', 'app.py')), 'a fresh launch starts from nothing').toBe(false);
    expect(JSON.parse(readFileSync(t.prd, 'utf8')).stories[0].completed, 'a fresh launch runs the authored PRD').toBe(false);
    expect(t.calls()).toMatch(/orch --phase scaffold --reset/);
  });

  it('a RESUME does not tear down the codeline: the previous phase\'s commit is still HEAD', () => {
    const t = launch({ resume: '20260915T101555Z' });
    expect(t.log, 'the resume tore the codeline down').not.toMatch(/Tearing down output directory/);
    expect(existsSync(join(t.out, 'src', 'app.py')), 'the scaffold phase\'s work is gone').toBe(true);
    expect(spawnSync('git', ['-C', t.out, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()).toBe(t.head);
  });

  it('a RESUME does not restore the authored PRD over the run\'s own: completed stories stay completed, spec stays', () => {
    const t = launch({ resume: '20260915T101555Z' });
    const prd = JSON.parse(readFileSync(t.prd, 'utf8'));
    expect(prd.stories[0].completed, 'the run\'s completed story was reset by the canonical restore').toBe(true);
    expect(prd.stories[1].specification?.runId, 'the spec pass\'s work was discarded — it will re-run and re-split').toBe('R1');
  });

  // A PAUSE IS NOT A COMPLETED PHASE. Run 8 (20260916T200051Z): the mint paused as designed, exit
  // 0; the launcher read exit 0 as "Phase 'scaffold' completed", started 'core', which minted and
  // paused AGAIN under a second run id (20260916T200108Z), then reported the project completed.
  it('a phase that PAUSES stops the launcher: no next phase, no second run id, the resume line printed', () => {
    const t = launch({ pauseAt: 'scaffold' });
    expect(t.calls().match(/^orch --phase/gm) || [], 'the next phase was started after a pause').toHaveLength(1);
    expect(t.log, 'a paused phase was reported completed').not.toMatch(/Phase 'scaffold' completed/);
    expect(t.log).toMatch(/paused/i);
    expect(t.log, 'the resume instruction must name the paused run').toMatch(/EPAM_RESUME_RUN=20260916T200051Z/);
    expect(t.r.status, 'a pause is not a failure').toBe(0);
  });

  it('a RESUME runs the phases without --reset and hands the run id down', () => {
    const t = launch({ resume: '20260915T101555Z' });
    const calls = t.calls();
    expect(calls, `the orchestrator was never invoked — launcher said:\n${t.log}`).toMatch(/^orch /m);
    expect(calls, '--reset on a resume clears every completed flag').not.toMatch(/--reset/);
    expect(calls).toMatch(/RESUME=20260915T101555Z/);
  });
});
