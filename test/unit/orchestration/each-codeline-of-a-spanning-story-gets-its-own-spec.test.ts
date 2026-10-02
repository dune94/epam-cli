/**
 * EACH CODELINE OF A SPANNING STORY GETS ITS OWN SPEC — AND THE BRIDGE CONTRACT IS KEPT.
 *
 * Live 2026-10-01, AMSD-2974 (cx-shared + three sites), sequential lanes, resumed from pause 1:
 *  1. cxshared's fix sites were merged into canonical first; the next lane's PRD fell back to that
 *     flat list, so gotransit/upexpress/metrolinx were each handed cx-shared's four files — files
 *     that do not exist in their checkouts.
 *  2. On the resume the spec pass skips a story that carries a spec mark, judged per STORY, so the
 *     three sites never had a spec pass of their own.
 *  3. The bridge agent returned its cross-codeline contract as its answer; the bridge counted only
 *     a file the agent wrote itself (outside its writable folder), so every attempt "failed", three
 *     per lane — most of the run's spend, for nothing.
 *
 * EXECUTED: the real filtered-prd.js, the real storiesLackingSpec, and the real _run_codeline_bridge
 * (taken from lib/codeline-lanes.sh, run in bash with a stand-in agent that answers in text).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const work = mkdtempSync(join(tmpdir(), 'spanning-spec-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const finding = (codeline: string, file: string) => ({ codeline, file, function: 'f', reason: 'r' });
/** Canonical as it stands after the FIRST lane (a) merged: only lane a has its own entry. */
const canonical = {
  implementationOrder: { core: ['S-1'] },
  stories: [{
    id: 'S-1', title: 't', status: 'in-progress', completed: false, codeline: 'a', codelines: ['a', 'b'],
    specification: { runId: 'R1', appliedAgents: ['openspec'] },
    fixSiteAnalysis: [finding('a', 'src/only-in-a.ts')],
    fixSiteAnalysisPerCodeline: { a: [finding('a', 'src/only-in-a.ts')] },
    verificationCriteria: ['v1'], verificationCriteriaPerCodeline: { a: ['v1'] },
  }],
};

function lanePrd(cl: string) {
  const src = join(work, 'canonical.json'); const out = join(work, `${cl}-prd.json`);
  writeFileSync(src, JSON.stringify(canonical));
  const r = spawnSync(process.execPath, [join(LIB, 'handlers/filtered-prd.js'), src, out, cl], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(readFileSync(out, 'utf8'));
}

describe('each codeline of a spanning story gets its own spec', () => {
  it('a lane never inherits another codeline\'s fix sites', () => {
    const b = lanePrd('b').stories[0];
    expect(b.codeline).toBe('b');
    expect((b.fixSiteAnalysis || []).filter((f: any) => f.codeline !== 'b'), 'lane b was handed lane a\'s files').toEqual([]);
  });

  it('the lane that found them keeps its own fix sites', () => {
    const a = lanePrd('a').stories[0];
    expect(a.fixSiteAnalysis.map((f: any) => f.file)).toEqual(['src/only-in-a.ts']);
  });

  it('on a resume, a lane with no spec of its own is not skipped — a lane with one is', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { storiesLackingSpec } = require(join(LIB, 'handlers/stories-lacking-spec.js'));
    expect(storiesLackingSpec(lanePrd('b'), 'core'), 'lane b was treated as specified by lane a\'s spec').toEqual(['S-1']);
    expect(storiesLackingSpec(lanePrd('a'), 'core')).toEqual([]);
  });

  it('a story confined to one codeline keeps today\'s rule: its spec mark is enough', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { storiesLackingSpec } = require(join(LIB, 'handlers/stories-lacking-spec.js'));
    const single = { implementationOrder: { core: ['S-2'] }, stories: [{ id: 'S-2', codeline: 'a', specification: { runId: 'R1' } }] };
    expect(storiesLackingSpec(single, 'core')).toEqual([]);
  });
});

describe('the bridge keeps a contract the agent returned as its answer', () => {
  const src = readFileSync(join(LIB, 'codeline-lanes.sh'), 'utf8');
  const start = src.indexOf('_run_codeline_bridge() {');
  const end = src.indexOf('\n}\n', start) + 3;
  const fn = src.slice(start, end);

  it('one call, the contract saved, success logged', () => {
    expect(start, 'the bridge function is gone').toBeGreaterThan(-1);
    const logDir = join(work, 'logs'); spawnSync('mkdir', ['-p', logDir]);
    const calls = join(work, 'calls');
    const script = `
set -u
LOG_DIR=${JSON.stringify(logDir)}; AUTOMATION_DIR=${JSON.stringify(work)}
log() { echo "LOG $*" >&2; }; warning() { echo "WARN $*" >&2; }; error() { echo "ERR $*" >&2; }
jq_vals() { cat >/dev/null 2>&1 || true; echo '{}'; }
render_engine_prompt() { echo "bridge prompt"; }
run_orch_prompt() { echo x >> ${JSON.stringify(calls)}; printf '# Contract for a\\nexport function shared(): void\\n'; }
${fn}
_run_codeline_bridge a /nowhere /nowhere.json
`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const out = join(logDir, 'cross-codeline-a.md');
    expect(existsSync(out), `no contract saved: ${r.stderr.slice(-600)}`).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('export function shared(): void');
    expect(readFileSync(calls, 'utf8').trim().split('\n').length, 'the bridge retried a contract it had').toBe(1);
    expect(r.stderr).toMatch(/Contract written/);
  });
});
