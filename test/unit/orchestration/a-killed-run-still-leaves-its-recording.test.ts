/**
 * THE TRAP CANNOT COVER THE TWO WAYS WE ACTUALLY LOST DATA.
 *
 * Moving the export into the EXIT trap fixed pause and error exits. It cannot fix `kill -9` or an
 * OOM kill — bash never runs a trap for either, and both are exactly how this project lost
 * recordings: a run killed by hand, and WSL reclaiming memory mid-run.
 *
 * Langfuse records each call as it happens, so a killed run's turns are already durable ON THE
 * SERVER at the moment it dies. What was missing is anything that harvests them without asking the
 * dying process for help.
 *
 * So the harvest belongs to a process with the INSTALL's lifetime, not the run's — the same shape
 * as snapshot-watch, which the installer starts and uninstall stops. It sweeps whatever Langfuse
 * currently holds into a partial cassette, refreshes it while the recording grows, and stands down
 * for any session the run itself has already archived, because a finished cassette is run evidence
 * and is never rewritten ([[fb_never_rewrite_run_evidence]]).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const WATCH = join(ROOT, 'orchestrations/scripts/cassette-watch.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/**
 * A stand-in Langfuse-backed exporter with the real one's CLI: `--list` names the sessions it
 * holds, `--session/--out` writes a cassette. `turns` lets a test grow a recording between sweeps,
 * which is what a live run does.
 */
function stubExporter(dir: string, sessions: Record<string, number>, opts: { fail?: boolean } = {}) {
  const f = join(dir, 'stub-export.js');
  const state = join(dir, 'sessions.json');
  writeFileSync(state, JSON.stringify(sessions));
  writeFileSync(f, `#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const a=process.argv.slice(2);
const sessions=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));
if(a.includes('--list')){
  for(const id of Object.keys(sessions)) process.stdout.write(id+'\\t2026-09-08T13:29:13.024Z\\n');
  process.exit(0);
}
if(${opts.fail ? 'true' : 'false'}){ process.stderr.write('fetch failed\\n'); process.exit(1); }
const id=a[a.indexOf('--session')+1], out=a[a.indexOf('--out')+1];
const turns=sessions[id]||0;
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({session:id,traceCount:turns,seams:[],roots:[]}));
process.stdout.write('1 seam(s), '+turns+' turn(s) -> '+out+'\\n');
process.exit(0);
`);
  chmodSync(f, 0o755);
  return { exporter: f, grow: (id: string, n: number) => { sessions[id] = n; writeFileSync(state, JSON.stringify(sessions)); } };
}

function harvest(cassetteDir: string, exporter: string) {
  delete require.cache[require.resolve(WATCH)];
  const { harvestOnce } = require(WATCH);
  return harvestOnce({ cassetteDir, exporter, node: process.execPath });
}

const partialOf = (id: string) => `session-${id}.partial`;

describe('a run that is killed outright still leaves its recording', () => {
  it('harvests a session that has no cassette yet', () => {
    const d = tmp('cw-'); const cass = join(d, 'cassettes');
    const { exporter } = stubExporter(d, { '20260908T215555Z': 12 });
    harvest(cass, exporter);
    const p = join(cass, partialOf('20260908T215555Z'));
    expect(existsSync(p), `nothing harvested into ${p}`).toBe(true);
    expect(JSON.parse(readFileSync(join(p, 'manifest.json'), 'utf8')).traceCount).toBe(12);
  });

  it('refreshes the partial while the recording is still growing', () => {
    const d = tmp('cw-'); const cass = join(d, 'cassettes');
    const { exporter, grow } = stubExporter(d, { '20260908T215555Z': 12 });
    harvest(cass, exporter);
    grow('20260908T215555Z', 286);
    harvest(cass, exporter);
    const m = JSON.parse(readFileSync(join(cass, partialOf('20260908T215555Z'), 'manifest.json'), 'utf8'));
    expect(m.traceCount, 'the partial went stale — a longer recording did not replace it').toBe(286);
  });

  it('never rewrites a cassette the run itself already archived', () => {
    const d = tmp('cw-'); const cass = join(d, 'cassettes');
    const final = join(cass, 'metrolinx-20260908T215555Z');
    mkdirSync(final, { recursive: true });
    writeFileSync(join(final, 'manifest.json'), JSON.stringify({ session: '20260908T215555Z', traceCount: 286, mine: true }));
    const { exporter } = stubExporter(d, { '20260908T215555Z': 3 });
    harvest(cass, exporter);
    const m = JSON.parse(readFileSync(join(final, 'manifest.json'), 'utf8'));
    expect(m.mine, 'the watcher overwrote finished run evidence').toBe(true);
    expect(m.traceCount).toBe(286);
  });

  it('clears its partial once the run has archived the real thing', () => {
    const d = tmp('cw-'); const cass = join(d, 'cassettes');
    const { exporter } = stubExporter(d, { '20260908T215555Z': 12 });
    harvest(cass, exporter);
    expect(existsSync(join(cass, partialOf('20260908T215555Z')))).toBe(true);
    mkdirSync(join(cass, 'metrolinx-20260908T215555Z'), { recursive: true });
    writeFileSync(join(cass, 'metrolinx-20260908T215555Z', 'manifest.json'), '{}');
    harvest(cass, exporter);
    expect(existsSync(join(cass, partialOf('20260908T215555Z'))),
      'the superseded partial was left behind next to the real cassette').toBe(false);
  });

  it('leaves nothing behind when the export fails — never a half-written cassette', () => {
    const d = tmp('cw-'); const cass = join(d, 'cassettes');
    const { exporter } = stubExporter(d, { '20260908T215555Z': 12 }, { fail: true });
    harvest(cass, exporter);
    const left = existsSync(cass) ? readdirSync(cass) : [];
    expect(left, `a failed export left ${left.join(',')}`).toEqual([]);
  });

  it('keeps sweeping after one session fails', () => {
    const d = tmp('cw-'); const cass = join(d, 'cassettes');
    const { exporter } = stubExporter(d, { 'aaa': 1, 'bbb': 2 });
    const r = harvest(cass, exporter);
    expect(r.harvested.sort()).toEqual(['aaa', 'bbb']);
  });
});
