/**
 * A RESUMED LANE KEEPS ITS COMPLETED STORY.
 *
 * AMSD-2974 run 9, resumes 9–12 (2026-10-13): the cxshared main line was approved, committed — and re-written by a paid
 * writer on every resume (resume 11's re-write regressed the approved placement fix). story_resume_completed_by_commit
 * marked the story completed in the lane PRD, then the lane called run-agent-orchestration.sh with `--reset`, whose
 * reset block sets every completed story of the phase back to pending (run-agent-orchestration.sh:964) — 33 s after the
 * mark, on every resume. The orchestrator's own rule (run-agent-orchestration.sh:1026): "A resume runs without --reset
 * (a reset would tear down completed phases)". The lane loop passed --reset unconditionally.
 *
 * EXECUTED: the real _lane_phase_args (lib/codeline-lanes.sh) — the argument the lane passes its phase call — for a lane
 * that resumed from its checkpoint, one that did not, and one whose spec is redone; then the orchestrator's real reset
 * block applied (or not) on a PRD whose story the resume rule marked completed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const FN = shellFunction(join(S, 'lib/codeline-lanes.sh'), '_lane_phase_args');
const RAO = readFileSync(join(S, 'run-agent-orchestration.sh'), 'utf8');
/** The orchestrator's reset block, as it runs when its arguments say --reset. */
const RESET_BLOCK = (() => {
  const a = RAO.indexOf('if [ "${RESET_STORIES:-false}" = "true" ]; then');
  const b = RAO.indexOf('    checkpoint_clear', a);
  if (a < 0 || b < 0) throw new Error('the orchestrator\'s reset block was not found — the harness is stale');
  return `${RAO.slice(a, b)}fi`;
})();

function args(env: Record<string, string>, specMode: string) {
  const r = spawnSync('bash', ['-c', `${FN}\n_lane_spec_mode=${JSON.stringify(specMode)}\nprintf '[%s]' "$(_lane_phase_args)"`],
    { encoding: 'utf8', env: { PATH: process.env.PATH || '', ...env } });
  const m = r.stdout.trim().match(/^\[(.*)\]$/);
  if (!m) throw new Error(`_lane_phase_args did not answer: ${r.stdout}${r.stderr}`);
  return m[1];
}

function completedAfterPhaseCall(laneArgs: string) {
  const d = mkdtempSync(join(tmpdir(), 'lane-reset-'));
  const prd = join(d, 'cxshared-prd.json');
  writeFileSync(prd, JSON.stringify({ implementationOrder: { core: ['S-1'] }, stories: [{ id: 'S-1', completed: true, status: 'completed' }] }));
  const r = spawnSync('bash', ['-c', [
    'log(){ :; }; success(){ :; }',
    `PRD_FILE=${JSON.stringify(prd)}; PHASE=core`,
    `case " ${laneArgs} " in *" --reset "*) RESET_STORIES=true ;; *) RESET_STORIES=false ;; esac`,
    RESET_BLOCK,
  ].join('\n')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(readFileSync(prd, 'utf8')).stories[0].completed;
}

describe('a resumed lane keeps its completed story', () => {
  it('a lane resumed from its checkpoint calls its phase WITHOUT --reset — the story the resume rule completed stays completed', () => {
    const a = args({ EPAM_RESUME_RUN: '20261010T043322Z' }, '0');
    expect(a).not.toContain('--reset');
    expect(completedAfterPhaseCall(a)).toBe(true);
  });

  it('NEGATIVE: a fresh lane (no resume) still resets — a new run starts clean', () => {
    const a = args({}, '');
    expect(a).toContain('--reset');
    expect(completedAfterPhaseCall(a)).toBe(false);
  });

  it('NEGATIVE: a resume whose lane is specified again (not resumed from its checkpoint) still resets', () => {
    expect(args({ EPAM_RESUME_RUN: '20261010T043322Z' }, '')).toContain('--reset');
  });
});
