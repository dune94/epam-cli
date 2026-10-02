/**
 * A RESUME CAN BE SENT BACK TO AN EARLIER STAGE — NEVER FORWARD.
 *
 * Operator, 2026-10-01 (AMSD-2974): rerun pause 1 → pause 2 after a spec fix. Every lane had a
 * pre-writer checkpoint, so a resume reported the run as past pause 2: the spec pass would rerun on
 * the restored pause-1 PRD, and the run would then go straight into the writer — the pause it had
 * "already passed" would not stop it. EPAM_RESUME_FROM_STAGE sends a resume back to an earlier stage;
 * a later stage than the run reached is refused, because skipping work the run never did is the one
 * thing a resume must not do.
 *
 * EXECUTED: the real lib/run-checkpoint.sh (run_stage, resume_skip_env) on a run directory laid out
 * as the pipeline writes it: a parent post-roster checkpoint and lanes at pre-writer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const base = mkdtempSync(join(tmpdir(), 'resume-stage-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const RID = 'R1';
const ck = (dir: string, stage: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ stage, runId: RID }));
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({ stories: [] }));
};
ck(join(base, 'runs', RID, 'checkpoint'), 'post-roster');
for (const l of ['a', 'b']) ck(join(base, 'runs', RID, 'lanes', l, 'checkpoint'), 'pre-writer');

function sh(fn: string, extra: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(join(LIB, 'run-checkpoint.sh'))}; is_parent() { return 0; }; ${fn} ${RID}`], {
    encoding: 'utf8', env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: base, NODE_BIN: process.execPath, ...extra },
  });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}

describe('a resume can be sent back to an earlier stage', () => {
  it('without the setting, the run is as far as its lanes: pre-writer', () => {
    expect(sh('run_stage').out).toBe('pre-writer');
  });

  it('EPAM_RESUME_FROM_STAGE=post-roster sends it back, and the resume no longer counts pause 2 as passed', () => {
    expect(sh('run_stage', { EPAM_RESUME_FROM_STAGE: 'post-roster' }).out).toBe('post-roster');
    const env = sh('resume_skip_env', { EPAM_RESUME_FROM_STAGE: 'post-roster' }).out;
    expect(env).toMatch(/EPAM_RESUMED_FROM_STAGE=post-roster/);
    expect(env).not.toMatch(/EPAM_RESUMED_FROM_STAGE=(post-spec|pre-writer)/);
  });

  it('a later stage than the run reached is refused, never honoured', () => {
    for (const l of ['a', 'b']) ck(join(base, 'runs', RID, 'lanes', l, 'checkpoint'), 'post-spec');
    const r = sh('run_stage', { EPAM_RESUME_FROM_STAGE: 'pre-writer' });
    expect(r.out).not.toBe('pre-writer');
    expect(r.err).toMatch(/EPAM_RESUME_FROM_STAGE/);
  });
});
