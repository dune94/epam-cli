/**
 * A LANE THAT PAUSED BEFORE ITS WRITER PAUSES THE RUN — it is not a lane that finished.
 *
 * Fresh rehearsal of AMSD-2974, 2026-10-09: with EPAM_PAUSE_BEFORE_WRITER every lane (and cx-shared's 7.x line) stopped
 * at "PAUSED — inputs ready, writer NOT started" and recorded paused-run.json in ITS OWN log dir. The lane runner then
 * logged "Phase 'core' — '<lane>' done.", nothing recorded the pause for the run, and the run ended "✅ Pipeline
 * complete." — so no launcher (orchestrate.sh, greenfield's loop, a rehearsal) could tell pause 2 from a finished run.
 *
 * EXECUTED: lib/codeline-lanes.sh's own functions — lane_paused_since (did this lane record a pause during this run) and
 * record_lanes_pause (the run-level record, through lib/checkpoints.sh record_run_pause) — on real lane log dirs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const sh = (cmd: string, logDir: string) => spawnSync('bash', ['-c', `set -u
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; info(){ :; }; error(){ echo "ERR $*"; }; success(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}
. ${JSON.stringify(join(SCRIPTS, 'lib/checkpoints.sh'))}
. ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
${cmd}`], { encoding: 'utf8', env: { ...process.env, LOG_DIR: logDir, ORCH_RUN_ID: 'R-NOW', PHASE: 'core' } });

function run() {
  const d = mkdtempSync(join(tmpdir(), 'lane-pause-')); dirs.push(d);
  const marker = join(d, '.lanes-started'); writeFileSync(marker, '');
  const old = new Date(Date.now() - 3600_000); utimesSync(marker, old, old);
  return { d, marker };
}
const pause = (dir: string, runId = 'R-NOW') => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'paused-run.json'), JSON.stringify({ runId, stage: 'pre-writer', phase: 'core', pausedAt: 'now' })); };

describe('lane_paused_since — did this lane pause during this run', () => {
  it('a lane that recorded a pause after the lanes started: paused', () => {
    const { d, marker } = run(); pause(join(d, 'lanes/cxshared'));
    expect(sh(`lane_paused_since ${d}/lanes/cxshared ${marker} && echo PAUSED || echo DONE`, d).stdout.trim()).toBe('PAUSED');
  });
  it('a lane with no record: finished', () => {
    const { d, marker } = run(); mkdirSync(join(d, 'lanes/gotransit'), { recursive: true });
    expect(sh(`lane_paused_since ${d}/lanes/gotransit ${marker} && echo PAUSED || echo DONE`, d).stdout.trim()).toBe('DONE');
  });
  it('a record left from an earlier launch (older than this run\'s lanes): not this run\'s pause', () => {
    const { d, marker } = run(); pause(join(d, 'lanes/cxshared'));
    const older = new Date(Date.now() - 7200_000); utimesSync(join(d, 'lanes/cxshared/paused-run.json'), older, older);
    expect(sh(`lane_paused_since ${d}/lanes/cxshared ${marker} && echo PAUSED || echo DONE`, d).stdout.trim()).toBe('DONE');
  });
  it('a release line of the lane paused (lanes/<cl>/lines/<line>): the lane paused', () => {
    const { d, marker } = run(); pause(join(d, 'lanes/cxshared/lines/7.x'));
    expect(sh(`lane_paused_since ${d}/lanes/cxshared ${marker} && echo PAUSED || echo DONE`, d).stdout.trim()).toBe('PAUSED');
  });
});

describe('record_lanes_pause — the run is paused when any lane paused', () => {
  it('lanes paused: the run-level record names this run and its stage, and says how to resume', () => {
    const { d, marker } = run(); pause(join(d, 'lanes/cxshared')); pause(join(d, 'lanes/upexpress'));
    const r = sh(`record_lanes_pause ${marker} && echo RECORDED || echo NONE`, d);
    expect(r.stdout, r.stderr).toMatch(/RECORDED/);
    expect(r.stdout).toMatch(/2 lane\(s\).*EPAM_RESUME_RUN=R-NOW/);
    const rec = JSON.parse(readFileSync(join(d, 'paused-run.json'), 'utf8'));
    expect(rec).toMatchObject({ runId: 'R-NOW', stage: 'pre-writer', phase: 'core' });
  });
  it('no lane paused: nothing recorded, the run is not paused', () => {
    const { d, marker } = run(); mkdirSync(join(d, 'lanes/cxshared'), { recursive: true });
    const r = sh(`record_lanes_pause ${marker} && echo RECORDED || echo NONE`, d);
    expect(r.stdout.trim()).toMatch(/NONE$/);
    expect(existsSync(join(d, 'paused-run.json'))).toBe(false);
  });
});
