/**
 * A RUN NEVER INHERITS ANOTHER RUN'S LANE STATE.
 *
 * Live AMSD-2974 run 2, at pause 2 (2026-10-09): each lane's log folder (logs/lanes/<lane>, lines/<line>) survives
 * every launch — the fresh-launch reset clears only logs/. Waiting for the Writer Phase there: upexpress's retry
 * counter at attempt 10 of 12 on opus-5.5, ladder positions per seam, a ".rejection-AMSD-2974" the identical-rejection
 * check reads, 17 self-heal events from Oct 6–8 the repeat check would compare against, old review and gate ledgers.
 *
 * Once per run, before any lane works, every file in the lane folders older than the run's own start moves to
 * logs/archive (never deleted). What this run wrote is newer and stays — its Spec Phase, a mid-run resume's own state.
 *
 * EXECUTED: lib/codeline-lanes.sh archive_prior_lane_state on real folders with real file times.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const RUN = '20261009T083016Z';
const RUN_START = Date.UTC(2026, 9, 9, 8, 30, 16) / 1000;
function file(p: string, epoch: number, body = 'x') { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); utimesSync(p, epoch, epoch); }

function estate() {
  const d = mkdtempSync(join(tmpdir(), 'lane-state-')); dirs.push(d);
  const logs = join(d, 'logs'); const cfg = join(d, 'cfg'); mkdirSync(cfg);
  const old = RUN_START - 86400; const mine = RUN_START + 3600;
  file(join(logs, 'lanes/upexpress/story-retry-state/AMSD-2974.count'), old, '10');
  file(join(logs, 'lanes/upexpress/.rejection-AMSD-2974'), old);
  file(join(logs, 'lanes/upexpress/agent-ladder/repro-test-writer.AMSD-2974'), old);
  file(join(logs, 'lanes/upexpress/healing-events.jsonl'), old);
  file(join(logs, 'lanes/cxshared/lines/7.x/code-reviews.jsonl'), old);
  file(join(logs, 'lanes/upexpress/paused-run.json'), mine);                          // this run's Spec Phase
  file(join(logs, 'lanes/cxshared/story-retry-state/code-graph-detective__AMSD-2974.count'), mine, '1');
  return { d, logs, cfg };
}
const archive = (e: ReturnType<typeof estate>, env: Record<string, string> = {}) => spawnSync('bash', ['-c', `set -u
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; info(){ :; }; error(){ echo "ERR $*"; }; success(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}
. ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))} 2>/dev/null
archive_prior_lane_state; echo "RC=$?"`], { encoding: 'utf8', env: { ...process.env, LOG_DIR: e.logs, EPAM_PROJECT_CONFIG_DIR: e.cfg, EPAM_RESUME_RUN: RUN, ...env } });

describe('another run\'s lane state is archived before this run\'s lanes work', () => {
  it('every file older than this run\'s start leaves the lane folders, into logs/archive', () => {
    const e = estate(); const r = archive(e);
    expect(r.stdout, r.stdout + r.stderr).toMatch(/RC=0/);
    for (const f of ['upexpress/story-retry-state/AMSD-2974.count', 'upexpress/.rejection-AMSD-2974', 'upexpress/agent-ladder/repro-test-writer.AMSD-2974',
      'upexpress/healing-events.jsonl', 'cxshared/lines/7.x/code-reviews.jsonl']) {
      expect(existsSync(join(e.logs, 'lanes', f)), f).toBe(false);
    }
    const arch = readdirSync(join(e.logs, 'archive')).find((n) => n.startsWith('lanes-before-'));
    expect(arch, 'nothing archived').toBeTruthy();
    expect(existsSync(join(e.logs, 'archive', arch!, 'upexpress/story-retry-state/AMSD-2974.count'))).toBe(true);
    expect(r.stdout).toMatch(/5 file\(s\)/);
  });
  it('what this run wrote stays where it is', () => {
    const e = estate(); archive(e);
    expect(existsSync(join(e.logs, 'lanes/upexpress/paused-run.json'))).toBe(true);
    expect(existsSync(join(e.logs, 'lanes/cxshared/story-retry-state/code-graph-detective__AMSD-2974.count'))).toBe(true);
  });
  it('once per run: a later leg archives nothing, even a file it finds old', () => {
    const e = estate(); archive(e);
    file(join(e.logs, 'lanes/gotransit/story-retry-state/AMSD-2974.count'), RUN_START - 10, '4');
    const r = archive(e);
    expect(r.stdout).not.toMatch(/archived/);
    expect(existsSync(join(e.logs, 'lanes/gotransit/story-retry-state/AMSD-2974.count'))).toBe(true);
  });
  it('a fresh launch (ORCH_RUN_ID, no resume) is read the same way', () => {
    const e = estate(); const r = archive(e, { EPAM_RESUME_RUN: '', ORCH_RUN_ID: RUN });
    expect(r.stdout).toMatch(/RC=0/);
    expect(existsSync(join(e.logs, 'lanes/upexpress/story-retry-state/AMSD-2974.count'))).toBe(false);
  });
});
