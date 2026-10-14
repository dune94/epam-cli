/**
 * A LANE ALREADY PAST PAUSE 2 IS NOT PAUSED AGAIN — EVEN WHEN ANOTHER LANE OF THE RUN IS BEHIND IT.
 *
 * AMSD-2974 run 9 (2026-10-14 01:34Z): the run's stage is its LEAST advanced lane (run_stage), and upexpress's checkpoint
 * was post-spec, so EPAM_RESUMED_FROM_STAGE was post-spec. The 7.x line's mutant-hunter gate failed, gate self-heal added
 * requirements and retried the line's phase — and the retry stopped at pause 2, "writer NOT started", although the line's
 * own checkpoint was pre-writer and the operator had resumed the run past that pause. The remediation never reached a
 * writer; every further resume would have stopped there again.
 *
 * EXECUTED: the real own_checkpoint_stage_snapshot and should_pause_before_writer (lib/run-checkpoint.sh) on a real
 * checkpoint layout — a release line and a lane, each with its own checkpoint, under a run whose slowest lane is post-spec.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CK = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function pauses(own: string | null, env: Record<string, string>) {
  const cfg = mkdtempSync(join(tmpdir(), 'pause-two-')); dirs.push(cfg);
  const lineDir = env.EPAM_RELEASE_LINE ? `/lines/${env.EPAM_RELEASE_LINE}` : '';
  const d = join(cfg, `runs/R1/lanes/lib${lineDir}/checkpoint`);
  mkdirSync(d, { recursive: true });
  if (own) writeFileSync(join(d, 'checkpoint.json'), JSON.stringify({ stage: own }));
  const r = spawnSync('bash', ['-c', `is_truthy(){ [ "$1" = 1 ]; }; is_parent(){ return 1; }
. ${JSON.stringify(CK)}
own_checkpoint_stage_snapshot
should_pause_before_writer && echo PAUSE || echo CONTINUE; echo "OWN=\${EPAM_OWN_STAGE_AT_START:-}"`],
  { encoding: 'utf8', env: { PATH: process.env.PATH || '', EPAM_PROJECT_CONFIG_DIR: cfg, ORCH_RUN_ID: 'R1', EPAM_RESUME_RUN: 'R1',
    EPAM_PAUSE_BEFORE_WRITER: '1', EPAM_RESUMED_FROM_STAGE: 'post-spec', EPAM_CODELINE: 'lib', ...env } });
  return r.stdout;
}

describe('a lane past pause 2 is not paused again', () => {
  it('the 7.x line\'s self-heal retry: its own checkpoint pre-writer, the run\'s slowest lane post-spec — it continues', () => {
    const out = pauses('pre-writer', { EPAM_RELEASE_LINE: '7.x' });
    expect(out, 'the snapshot read nothing — the case would be vacuous').toContain('OWN=pre-writer');
    expect(out).toContain('CONTINUE');
  });

  it('a lane whose own checkpoint is pre-writer continues', () => {
    expect(pauses('pre-writer', {})).toContain('CONTINUE');
  });

  it('NEGATIVE: a lane reaching pause 2 for the first time (its own checkpoint post-spec) still pauses', () => {
    expect(pauses('post-spec', {})).toContain('PAUSE\n');
  });

  it('NEGATIVE: a lane with no checkpoint of its own still pauses', () => {
    expect(pauses(null, {})).toContain('PAUSE\n');
  });

  it('NEGATIVE: a fresh run (no resume) still pauses', () => {
    expect(pauses('pre-writer', { EPAM_RESUME_RUN: '', EPAM_RESUMED_FROM_STAGE: '' })).toContain('PAUSE\n');
  });
});
