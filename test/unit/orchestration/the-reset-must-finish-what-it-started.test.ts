/**
 * THE RESET MUST FINISH WHAT IT STARTED.
 *
 * pre-run-reset.sh runs under `set -euo pipefail` and clears previous-run state in
 * sequence. At line 386 it counted what survived clearing an agent-io store:
 *
 *     rm -rf "$_aio" 2>/dev/null || true
 *     _AIO_LEFT=$(( _AIO_LEFT + $(find "$_aio" -mindepth 1 -type f 2>/dev/null | wc -l) ))
 *
 * When the `rm -rf` SUCCEEDS the directory no longer exists, so `find` exits 1;
 * `pipefail` propagates that through `| wc -l`; the arithmetic assignment inherits it;
 * and `set -e` kills the script. The reset aborted precisely BECAUSE the clearing had
 * worked — and everything sequenced after line 386 never ran:
 *
 *     story-retry-state/      (attempt counts + the model the ladder resumed on)
 *     kb-scratchpad/*.md
 *     the roster clear
 *
 * The launcher then read the non-zero exit through lib/pre-run-reset-gate.sh, which
 * distinguishes only CONTAMINATION_EXIT from "environmental", and logged:
 *
 *     pre-run-reset.sh exited 1 (dashboard/environment, not state) — non-fatal, continuing
 *
 * It was entirely about state. Live consequence, run 20260814T223413Z: the story began
 * with the previous run's count of 12/12 attempts, so it "failed after 12 attempts" in
 * 18 seconds having made ZERO model calls and spent $0, and resumed on a rung the PRD
 * never chose.
 *
 * These tests run the REAL script against a real populated LOG_DIR. The assertion that
 * matters is not the exit code — it is that the state which must not survive, did not.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RESET = join(__dirname, '../../../orchestrations/scripts/pre-run-reset.sh');

/** A LOG_DIR carrying exactly the state a finished run leaves behind. */
function seededRun() {
  const dir = mkdtempSync(join(tmpdir(), 'prr-'));
  const logDir = join(dir, 'logs');

  // Published agent inputs — the store whose successful removal triggered the abort.
  mkdirSync(join(logDir, 'agent-io', 'AMSD-1'), { recursive: true });
  writeFileSync(join(logDir, 'agent-io', 'AMSD-1', 'fix-plan'), 'a previous run\'s plan\n');

  // The state that must not survive into the next run.
  mkdirSync(join(logDir, 'story-retry-state'), { recursive: true });
  writeFileSync(join(logDir, 'story-retry-state', 'AMSD-1.count'), '12\n');
  writeFileSync(join(logDir, 'story-retry-state', 'AMSD-1.model'), 'some-top-rung-model\n');

  mkdirSync(join(logDir, 'kb-scratchpad'), { recursive: true });
  writeFileSync(join(logDir, 'kb-scratchpad', 'AMSD-1-attempt-9.md'), '# stale\n');

  const prd = join(dir, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'x' },
    stories: [{ id: 'AMSD-1', title: 't' }],
    implementationOrder: { core: ['AMSD-1'] },
  }));

  const res = spawnSync('bash', [RESET, '--prd', prd, '--log-dir', logDir], {
    encoding: 'utf8', timeout: 240000,
  });

  const count = (sub: string) =>
    existsSync(join(logDir, sub)) ? readdirSync(join(logDir, sub)).length : 0;

  const out = (res.stdout || '') + (res.stderr || '');
  const result = {
    status: res.status,
    out,
    retryState: count('story-retry-state'),
    scratchpad: readdirSync(join(logDir, 'kb-scratchpad')).filter((f) => f.endsWith('.md')).length,
    agentIo: existsSync(join(logDir, 'agent-io'))
      ? readdirSync(join(logDir, 'agent-io')).length : 0,
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('pre-run-reset clears every kind of previous-run state', () => {
  const r = seededRun();

  it('runs to completion', () => {
    expect(r.status, `the reset aborted early:\n${r.out}`).toBe(0);
  });

  it('clears story retry state — the count AND the resumed model', () => {
    // This is the one that cost a run: 12/12 inherited, so the story failed in 18
    // seconds having called no model at all.
    expect(
      r.retryState,
      `${r.retryState} retry-state file(s) survived — the next run starts already exhausted`,
    ).toBe(0);
  });

  it('clears the published agent inputs', () => {
    expect(r.agentIo).toBe(0);
  });

  it('clears the KB scratchpad', () => {
    // Sequenced AFTER the abort point, so it is a second witness that the script
    // reached the end rather than stopping at the first thing that happened to work.
    expect(r.scratchpad).toBe(0);
  });

  it('emits the completion sentinel the launcher gate requires', () => {
    expect(r.out).toMatch(/PRE_RUN_RESET_STATE_CLEARED/);
  });

  it('does not abort merely because a clear SUCCEEDED', () => {
    // The specific defect: `rm -rf` removes the directory, `find` on the now-missing
    // path exits 1, pipefail propagates it, set -e kills the script. Success looked
    // like failure, and everything after it silently did not happen.
    expect(r.out).not.toMatch(/could NOT be cleared/);
  });
});

/**
 * THE GATE, NOT JUST THE SCRIPT.
 *
 * Fixing line 386 removes today's abort. It does not remove the CLASS: any future
 * command that fails part-way through a `set -e` script exits 1 having skipped every
 * remaining state-clearing step, and an exit code cannot say where it stopped. The gate
 * therefore requires positive proof of completion and refuses the launch without it.
 *
 * This drives the REAL gate with a stand-in reset script, because what matters is the
 * launcher's decision, not the reset's internals.
 */
describe('the launcher gate refuses a reset that stopped part-way', () => {
  const GATE = join(__dirname, '../../../orchestrations/scripts/lib/pre-run-reset-gate.sh');

  function runGate(resetBody: string) {
    const dir = mkdtempSync(join(tmpdir(), 'prr-gate-'));
    try {
      const fake = join(dir, 'fake-reset.sh');
      writeFileSync(fake, `#!/usr/bin/env bash\n${resetBody}\n`);
      const res = spawnSync('bash', ['-c', `
        error() { echo "ERROR: $*" >&2; }
        info()  { echo "INFO: $*"; }
        PRE_RUN_RESET_SCRIPT=${JSON.stringify(fake)}
        . ${JSON.stringify(GATE)}
        pre_run_reset_or_abort --prd /dev/null
        echo "LAUNCH_CONTINUED"
      `], { encoding: 'utf8' });
      return { status: res.status, out: (res.stdout || '') + (res.stderr || '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('continues when the reset completed and said so', () => {
    const r = runGate('echo "did the work"; echo PRE_RUN_RESET_STATE_CLEARED; exit 0');
    expect(r.out).toMatch(/LAUNCH_CONTINUED/);
  });

  it('REFUSES when the reset died before finishing, even though exit 1 looks environmental', () => {
    // Exactly the live shape: partial work, exit 1, no sentinel.
    const r = runGate('echo "Archiving and clearing run logs..."; exit 1');
    expect(r.out).not.toMatch(/LAUNCH_CONTINUED/);
    expect(r.out).toMatch(/REFUSING TO LAUNCH/);
    expect(r.out).toMatch(/did not finish its state clearing/);
  });

  it('REFUSES a reset that exits 0 without doing the state work', () => {
    // A silent no-op is not a clean slate. Absence of the sentinel is the signal, not
    // the exit code — otherwise a script that returns 0 early passes unnoticed.
    const r = runGate('echo "nothing to do"; exit 0');
    expect(r.out).not.toMatch(/LAUNCH_CONTINUED/);
    expect(r.out).toMatch(/REFUSING TO LAUNCH/);
  });
});
