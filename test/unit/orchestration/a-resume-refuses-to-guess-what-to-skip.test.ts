/**
 * RESUME, EXTRACTED AND EXECUTED — IT DECIDES WHETHER A RUN SPENDS AGAIN.
 *
 * Second extraction from run-agent-orchestration.sh's inline body, for the same reason as the
 * first: top-level statements run only when the script runs, so nothing but a full pipeline could
 * reach these 37 lines. What they decide is not small. A resume restores a checkpoint, works out
 * which steps to skip, and then either continues the run or refuses it.
 *
 * The refusals are the point, and the file prices one of them: a resume that skips the spec pass
 * against a PRD carrying none of its output hands the writer a story with nothing to aim at —
 * "measured 2026-08-10 at $11.76 and no code". Three separate refusals guard that, and none had
 * ever been executed by a test:
 *
 *   - the checkpoint cannot be restored          → refuse, and list what checkpoints exist
 *   - what to skip cannot be determined          → refuse rather than guess
 *   - the spec pass is skipped, but the PRD      → refuse, and say how to recover
 *     carries no spec output
 *
 * Each is asserted here by calling the real function with its collaborators stubbed to the states
 * that actually occur. A refusal that has never run is a refusal nobody has seen work.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/orchestration-resume.sh');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

type Stubs = {
  parent?: boolean;
  resumeRun?: string;
  restoreOk?: boolean;
  skipEnvOk?: boolean;
  skipEnv?: string;
  specMode?: string;
  specPresent?: boolean;
};

/**
 * Call the real function with its collaborators stubbed. Those collaborators live in other files
 * the orchestrator sources; what is under test is this block's own decisions.
 */
function resume(s: Stubs) {
  const script = `
    set +e
    error()   { echo "ERROR: $*" >&2; }
    info()    { echo "INFO: $*"; }
    success() { echo "SUCCESS: $*"; }
    is_parent() { ${s.parent === false ? 'return 1' : 'return 0'}; }
    restore_run_checkpoint()      { ${s.restoreOk === false ? 'return 1' : 'return 0'}; }
    list_run_checkpoints()        { printf '20260101T000000Z\\n20260102T000000Z\\n'; }
    resume_skip_env()             { ${s.skipEnvOk === false ? 'return 1' : `printf '%s' ${JSON.stringify(s.skipEnv ?? 'EPAM_SPEC_MODE=0')}`}; }
    resume_spec_output_present()  { ${s.specPresent === false ? 'return 1' : 'return 0'}; }
    PRD_FILE=/tmp/does-not-matter.json
    ${s.resumeRun === undefined ? '' : `export EPAM_RESUME_RUN=${JSON.stringify(s.resumeRun)}`}
    ${s.specMode === undefined ? '' : `export EPAM_SPEC_MODE=${JSON.stringify(s.specMode)}`}
    . ${JSON.stringify(LIB)}
    apply_resume_if_requested
    echo "RC=$?"
    echo "RUN_ID=${'${ORCH_RUN_ID:-unset}'}"
    echo "SPEC_MODE=${'${EPAM_SPEC_MODE:-unset}'}"
  `;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    // Inherit, so the shell coverage collector's BASH_ENV instrumentation survives.
    env: { ...process.env, EPAM_RESUME_RUN: '', EPAM_SPEC_MODE: '' },
  });
  const out = r.stdout || '';
  return {
    out, err: r.stderr || '', status: r.status,
    val: (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1] ?? null),
  };
}

describe('a resume refuses to guess what to skip', () => {
  it('the library exists and defines the function', () => {
    expect(existsSync(LIB), 'the resume block has not been extracted yet').toBe(true);
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; type -t apply_resume_if_requested`],
      { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').trim()).toBe('function');
  }, 40_000);

  it('does nothing at all when no resume was asked for', () => {
    const r = resume({});
    expect(r.val('RC')).toBe('0');
    expect(r.val('RUN_ID'), 'a normal run had its run id overwritten').toBe('unset');
  }, 70_000);

  it('does nothing in a child process, however the environment looks', () => {
    // Only the parent resumes. A child acting on EPAM_RESUME_RUN would restore a checkpoint
    // underneath a run already in progress.
    const r = resume({ parent: false, resumeRun: '20260101T000000Z' });
    expect(r.val('RC')).toBe('0');
    expect(r.val('RUN_ID')).toBe('unset');
  }, 70_000);

  it('adopts the resumed run id and reports success', () => {
    const r = resume({ resumeRun: '20260101T000000Z' });
    expect(r.val('RC')).toBe('0');
    expect(r.val('RUN_ID')).toBe('20260101T000000Z');
    expect(r.out).toMatch(/RESUMED run 20260101T000000Z/);
  }, 70_000);

  it('exports every assignment the skip environment names', () => {
    const r = resume({ resumeRun: '20260101T000000Z', skipEnv: 'EPAM_SPEC_MODE=0', specPresent: true });
    expect(r.val('SPEC_MODE'), 'the resume did not apply the skip it computed').toBe('0');
  }, 70_000);

  it('REFUSES when the checkpoint cannot be restored, and names what exists', () => {
    const r = resume({ resumeRun: 'nope', restoreOk: false });
    expect(r.status, 'a run continued against un-restored state').not.toBe(0);
    expect(r.err).toMatch(/cannot resume run/);
    expect(r.err, 'the refusal does not say which checkpoints are available')
      .toMatch(/20260101T000000Z/);
  }, 70_000);

  it('REFUSES rather than guessing what to skip', () => {
    const r = resume({ resumeRun: '20260101T000000Z', skipEnvOk: false });
    expect(r.status, 'the run guessed which steps to skip').not.toBe(0);
    expect(r.err).toMatch(/refusing to guess/);
  }, 70_000);

  it('THE $11.76 REFUSAL: skipping the spec pass with no spec output in the PRD', () => {
    // The writer would be handed a story with nothing to aim at. The refusal must also say how to
    // recover, because the operator cannot tell from the symptom what overwrote the PRD.
    const r = resume({ resumeRun: '20260101T000000Z', skipEnv: 'EPAM_SPEC_MODE=0',
      specMode: '0', specPresent: false });
    expect(r.status, 'a resume ran the writer against a PRD with no specification').not.toBe(0);
    expect(r.err).toMatch(/carries none of its output/);
    expect(r.err, 'the refusal offers no way out').toMatch(/Recover with/);
  }, 70_000);

  it('and allows it when the PRD DOES carry the spec output', () => {
    // The negative half: the guard must not block every resume that skips the spec pass.
    const r = resume({ resumeRun: '20260101T000000Z', skipEnv: 'EPAM_SPEC_MODE=0',
      specMode: '0', specPresent: true });
    expect(r.val('RC'), `a valid resume was refused:\n${r.err}`).toBe('0');
  }, 70_000);

  it('THE ORCHESTRATOR USES IT — an extraction nothing calls is dead code', () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the orchestrator does not source the extracted resume block')
      .toMatch(/lib\/orchestration-resume\.sh/);
    expect(src, 'the orchestrator does not call it').toMatch(/apply_resume_if_requested/);
    expect(src, 'the inline resume block is still there, so the extraction changed nothing')
      .not.toMatch(/^if is_parent && \[ -n "\$\{EPAM_RESUME_RUN:-\}" \]; then$/m);
  }, 40_000);
});
