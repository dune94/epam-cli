/**
 * THE RESTORE MUST NOT UNDO THE EDIT THE PAUSE ASKED FOR.
 *
 * Pause 1 says, in as many words: "Resume re-reads those files and VALIDATES your edits. It does not
 * re-mint and does not re-assign over your changes." Measured 2026-08-28 on a rehearsal: an operator
 * reassigned a story at the pause, resumed, and the resume put the old role back in both the PRD and
 * the assignments. The banner was not describing the code.
 *
 * The cause is not malice in the restore, it is missing knowledge. restore_run_checkpoint already
 * refuses to move the PRD BACKWARDS, measured in spec items — a rule written after a restore blanked
 * a lane's work and cost ~50 minutes. But spec items cannot see a role reassignment: the edited PRD
 * has exactly as many as the checkpoint, so "not backwards" says copy, and the edit is gone.
 *
 * What was missing is a record of what the operator was actually shown. reviewed/ now holds those
 * exact bytes, so "did a human change this after the pause?" is a byte comparison rather than a
 * guess — and a file that differs from what was handed over is never silently overwritten.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/run-checkpoint.sh');
const RUN = '20260828T161717Z';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const prd = (role: string, spec: string[] = []) => JSON.stringify({
  stories: [{ id: 'S-1', agentRole: 'fare-rules-engineer', verificationCriteria: spec },
            { id: 'S-2', agentRole: role, verificationCriteria: spec }],
});

/** A run checkpointed at pause 1, with reviewed/ holding what the operator was shown. */
function atPauseOne(opts: { live: string; kept: string; reviewed?: string; profilesLive?: string;
                           profilesKept?: string; profilesReviewed?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'restore-edit-')); dirs.push(d);
  const cfg = join(d, 'project'), agents = join(d, 'agents');
  const ck = join(cfg, 'runs', RUN, 'checkpoint');
  mkdirSync(join(ck, 'reviewed'), { recursive: true });
  mkdirSync(agents, { recursive: true });

  const prdFile = join(cfg, 'prd.json');
  writeFileSync(prdFile, opts.live);
  writeFileSync(join(ck, 'prd.json'), opts.kept);
  writeFileSync(join(ck, 'reviewed', 'prd.json'), opts.reviewed ?? opts.kept);
  writeFileSync(join(ck, 'checkpoint.json'),
    JSON.stringify({ runId: RUN, stage: 'post-roster', phase: 'core', storyCount: 2 }));

  const profFile = join(agents, 'profiles.json');
  writeFileSync(profFile, opts.profilesLive ?? '{"agents":["as-minted"]}');
  writeFileSync(join(ck, 'profiles.json'), opts.profilesKept ?? '{"agents":["as-minted"]}');
  writeFileSync(join(ck, 'reviewed', 'profiles.json'),
    opts.profilesReviewed ?? opts.profilesKept ?? '{"agents":["as-minted"]}');

  return { d, cfg, agents, prdFile, profFile };
}

function restore(w: ReturnType<typeof atPauseOne>) {
  const r = spawnSync('bash', ['-c',
    `is_truthy(){ return 1; }; info(){ :; }; warning(){ :; }; log(){ :; }; is_parent(){ return 0; }
     source ${JSON.stringify(LIB)}
     restore_run_checkpoint ${RUN}`,
  ], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: w.cfg, EPAM_AGENTS_DIR: w.agents,
           PRD_FILE: w.prdFile, AGENT_PROFILES_FILE: w.profFile, ORCH_RUN_ID: RUN, PHASE: 'core' },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

describe('AN EDIT MADE AT THE PAUSE OUTRANKS THE CHECKPOINT COPY', () => {
  it('keeps a story reassigned by the operator', () => {
    const w = atPauseOne({
      live: prd('schedule-display-engineer'),   // what the operator saved at the pause
      kept: prd('fare-rules-engineer'),         // what the run had recorded
    });
    const r = restore(w);
    expect(r.status, `restore failed: ${r.out}`).toBe(0);
    expect(JSON.parse(readFileSync(w.prdFile, 'utf8')).stories[1].agentRole,
      'the resume put the old role back over the operator edit — exactly what the pause banner '
      + 'promises it will not do')
      .toBe('schedule-display-engineer');
  });

  it('says so, rather than keeping the edit silently', () => {
    const w = atPauseOne({ live: prd('schedule-display-engineer'), kept: prd('fare-rules-engineer') });
    expect(restore(w).out).toMatch(/edit|operator|KEEPING/i);
  });

  it('keeps an edited roster too', () => {
    const w = atPauseOne({
      live: prd('fare-rules-engineer'), kept: prd('fare-rules-engineer'),
      profilesLive: '{"agents":["HAND-EDITED"]}', profilesKept: '{"agents":["as-minted"]}',
      profilesReviewed: '{"agents":["as-minted"]}',
    });
    restore(w);
    expect(readFileSync(w.profFile, 'utf8'),
      'an operator brief rewritten at the pause was overwritten by the checkpoint copy')
      .toContain('HAND-EDITED');
  });
});

describe('AND THE RESTORE STILL DOES ITS ORIGINAL JOB', () => {
  it('restores the checkpoint PRD when the operator changed nothing', () => {
    // Untouched since the pause: reviewed/ and live agree, so the checkpoint copy governs. This is
    // the path that recovers a run whose live PRD was damaged after the pause.
    const w = atPauseOne({
      live: prd('fare-rules-engineer'),
      kept: prd('fare-rules-engineer', ['VC-1', 'VC-2']),
      reviewed: prd('fare-rules-engineer'),
    });
    restore(w);
    expect(JSON.parse(readFileSync(w.prdFile, 'utf8')).stories[1].verificationCriteria,
      'an untouched PRD was not restored from the checkpoint').toHaveLength(2);
  });

  it('still refuses to move a PRD backwards', () => {
    // The rule that already existed, written after a restore blanked a lane's work: a live PRD
    // richer than the checkpoint is kept whatever else is true.
    const w = atPauseOne({
      live: prd('fare-rules-engineer', ['VC-1', 'VC-2', 'VC-3']),
      kept: prd('fare-rules-engineer'),
      reviewed: prd('fare-rules-engineer', ['VC-1', 'VC-2', 'VC-3']),
    });
    restore(w);
    expect(JSON.parse(readFileSync(w.prdFile, 'utf8')).stories[1].verificationCriteria).toHaveLength(3);
  });
});

describe('_operator_edited — the comparison the restore defers to', () => {
  // Named directly, not only reached through restore_run_checkpoint: a blocking function no test
  // has ever heard of is how three guards reached production inert while the suite was green.

  const ask = (live: string | null, shown: string | null) => {
    const d = mkdtempSync(join(tmpdir(), 'edited-')); dirs.push(d);
    const a = join(d, 'live.json'), b = join(d, 'shown.json');
    if (live !== null) writeFileSync(a, live);
    if (shown !== null) writeFileSync(b, shown);
    const r = spawnSync('bash', ['-c',
      `source ${JSON.stringify(LIB)}
       if _operator_edited ${JSON.stringify(a)} ${JSON.stringify(b)}; then echo EDITED; else echo UNCHANGED; fi`,
    ], { encoding: 'utf8', timeout: 60000 });
    return (r.stdout || '').trim().split('\n').pop();
  };

  it('reports an edit when the live file differs from what was shown', () => {
    expect(ask('{"role":"schedule-display-engineer"}', '{"role":"fare-rules-engineer"}')).toBe('EDITED');
  });

  it('reports nothing when the operator left it alone', () => {
    expect(ask('{"role":"same"}', '{"role":"same"}')).toBe('UNCHANGED');
  });

  it('reports nothing when no copy was ever shown', () => {
    // A stage that predates reviewed/ must keep the old restore behaviour rather than treat every
    // file as edited and stop restoring altogether.
    expect(ask('{"role":"whatever"}', null)).toBe('UNCHANGED');
  });

  it('reports nothing when the live file is missing', () => {
    expect(ask(null, '{"role":"shown"}')).toBe('UNCHANGED');
  });
});
