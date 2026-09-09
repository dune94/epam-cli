/**
 * THE SWEEP TOOK EVERYTHING LANGFUSE HELD.
 *
 * Proven live against the running stack: one sweep harvested 21 sessions, of which exactly ONE was
 * a run. The other twenty were throwaway probes — a cost-seam check, an emitter smoke test, a bash
 * capability probe — each a single trace. Left alone, the cassette directory accumulates a partial
 * for every probe anyone ever fires, and the real recordings get harder to find among them.
 *
 * A run session is not identified by a prefix — filtering on "test-" or "costseam-" would be
 * hardcoding a naming convention nobody declared, and the next probe would use a new prefix. It is
 * identified by the SHAPE THE PIPELINE MINTS: run-agent-orchestration.sh mints a run id as a UTC
 * compact timestamp, and that shape is declared once in config/observability.json for the
 * consumers that must recognise one.
 *
 * The last test here is the one that keeps the two honest: it EXECUTES the pipeline's own mint and
 * asserts the declared pattern accepts what it produced. If the mint ever changes shape, this fails
 * rather than the harvest silently going blind.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const WATCH = join(ROOT, 'orchestrations/scripts/cassette-watch.js');
const OBS_CONFIG = join(ROOT, 'orchestrations/config/observability.json');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

function stubExporter(dir: string, sessions: string[]) {
  const f = join(dir, 'stub-export.js');
  writeFileSync(f, `#!/usr/bin/env node
const fs=require('fs'), path=require('path');
const a=process.argv.slice(2);
const sessions=${JSON.stringify(sessions)};
if(a.includes('--list')){ for(const id of sessions) process.stdout.write(id+'\\t2026-09-08T13:29:13.024Z\\n'); process.exit(0); }
const id=a[a.indexOf('--session')+1], out=a[a.indexOf('--out')+1];
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({session:id,traceCount:1,seams:[],roots:[]}));
process.exit(0);
`);
  chmodSync(f, 0o755);
  return f;
}

function harvest(cassetteDir: string, exporter: string) {
  delete require.cache[require.resolve(WATCH)];
  const { harvestOnce } = require(WATCH);
  return harvestOnce({ cassetteDir, exporter, node: process.execPath });
}

/** The exact session ids the live stack returned, runs and probes together. */
const REAL_RUN = '20260908T215555Z';
const REAL_PROBES = [
  'test-1464189-1788991819218-bash',
  'costseam-1446224-1788991790334',
  'e2e-emitter-1788911339041',
  'test-3342722-1788911383149',
];

describe('the harvest sweeps runs, not every probe anyone fired', () => {
  it('harvests a run', () => {
    const d = tmp('cwf-'); const cass = join(d, 'cassettes');
    const r = harvest(cass, stubExporter(d, [REAL_RUN]));
    expect(r.harvested).toContain(REAL_RUN);
  });

  it('leaves the probe sessions alone — all four shapes seen live', () => {
    const d = tmp('cwf-'); const cass = join(d, 'cassettes');
    const r = harvest(cass, stubExporter(d, [...REAL_PROBES, REAL_RUN]));
    expect(r.harvested, `swept probes: ${r.harvested.join(', ')}`).toEqual([REAL_RUN]);
    const left = existsSync(cass) ? readdirSync(cass) : [];
    expect(left, `probe partials written: ${left.join(', ')}`).toEqual([`session-${REAL_RUN}.partial`]);
  });

  it('the run-session shape is DECLARED, not written into the sweep', () => {
    const cfg = JSON.parse(readFileSync(OBS_CONFIG, 'utf8'));
    expect(cfg.runSession?.idPattern, 'observability.json declares no run-session shape').toBeTruthy();
    const src = readFileSync(WATCH, 'utf8');
    expect(/costseam|e2e-emitter|test-/.test(src),
      'the sweep hardcodes a probe naming convention instead of reading the declaration').toBe(false);
  });

  it('THE BINDING: the declared pattern accepts what the pipeline actually mints', () => {
    // Executes the real mint — not a re-typed copy, and not a source grep.
    const line = readFileSync(ORCH, 'utf8').split('\n').find((l) => /ORCH_RUN_ID=.*date -u/.test(l));
    expect(line, 'run-agent-orchestration.sh no longer mints a run id with date -u').toBeTruthy();
    const fmt = /date -u (\+\S+?)\)/.exec(line!)?.[1];
    expect(fmt, `could not read the mint format out of: ${line}`).toBeTruthy();
    const minted = spawnSync('date', ['-u', fmt!], { encoding: 'utf8' }).stdout.trim();
    expect(minted, 'the mint produced nothing').toBeTruthy();

    const pattern = JSON.parse(readFileSync(OBS_CONFIG, 'utf8')).runSession.idPattern;
    expect(new RegExp(pattern).test(minted),
      `the declared pattern ${pattern} rejects a freshly minted run id ${minted} — ` +
      'the harvest would skip every real run').toBe(true);
  });

  it('refuses to sweep at all when nothing declares the shape — never falls back to everything', () => {
    const d = tmp('cwf-'); const cass = join(d, 'cassettes');
    delete require.cache[require.resolve(WATCH)];
    const { harvestOnce } = require(WATCH);
    const r = harvestOnce({ cassetteDir: cass, exporter: stubExporter(d, [REAL_RUN, ...REAL_PROBES]),
                            node: process.execPath, runSessionPattern: '' });
    expect(r.harvested, `swept with no declared shape: ${r.harvested.join(', ')}`).toEqual([]);
    expect(r.refused, 'a sweep with no declared shape must say so').toBe(true);
  });
});
