/**
 * WHAT THE MOCK LOADER REGISTERS, AND WHAT IT SAYS IT REGISTERED.
 *
 * Three properties of mock-expectations.js, in one file because they share one piece of mutable
 * global state — the MockServer instance on :1080. Each suite resets it and re-registers every
 * seam, and vitest runs separate test FILES in parallel workers, so as three files they raced:
 * one suite read the expectations another had just replaced. The failure landed on whichever lost,
 * and it lied in the useful direction, reporting a clean result for a payload it never saw.
 * Within one file they run in sequence and the server has one owner at a time. It is also three
 * times faster, because the loader runs once instead of once per file.
 *
 * ── 1. THE REPORT NAMES EVERY SEAM IT ANSWERED FOR ──────────────────────────────────────────
 *
 * The summary printed two of six buckets. A rehearsal of 40 seams said "covered 9" and
 * "UNCOVERED 0" — both true, and together they read as complete coverage while 28 seams answered
 * with a contract stand-in carrying the declared fields and nothing else, and 14 more had a REAL
 * recording that could not be served. A count whose method is not stated implies completeness it
 * does not have.
 *
 * ── 2. A CASSETTE IS A SESSION, NOT ITS LAST SENTENCE ───────────────────────────────────────
 *
 * cassetteReply walked a capture's turns in reverse and returned the first carrying text, because
 * "the last one carries the answer the pipeline consumed". True for a seam that answers by TALKING.
 * roster-specialiser writes its roster with bash: its recording is a session of tool calls
 * including the write, followed by a sentence describing it. Serving the sentence left no file
 * behind and the contract refused three attempts running.
 *
 * ── 3. A REPLAYED ACTION TARGETS THIS RUN'S PROJECT ─────────────────────────────────────────
 *
 * That recording's write names the project it was recorded against. Replayed elsewhere it writes
 * into another project's config directory — one nobody asked for — while the contract looks under
 * the project actually running and finds nothing. Writing somewhere else is the worse half: it is
 * silent, and the run reports a missing roster rather than an unexpected write.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LOADER = join(REPO, 'orchestrations/scripts/mock-expectations.js');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');
const THIS_PROJECT = 'mock3';
const PROJECT_DIR = join(REPO, 'orchestrations/projects', THIS_PROJECT);
const PRD = join(PROJECT_DIR, 'prd.json');
const CASSETTE = join(REPO,
  'orchestrations/cassettes/metrolinx-latest-20260823T034354Z/roster-specialiser.json');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const SEAM = 'roster-specialiser';

function mockServerUp(): boolean {
  const r = spawnSync(NODE20, ['-e', `
    const http = require('http');
    const rq = http.request({ host: '127.0.0.1', port: 1080, path: '/mockserver/status',
      method: 'PUT', timeout: 4000 }, (res) => process.exit(res.statusCode === 200 ? 0 : 1));
    rq.on('error', () => process.exit(1));
    rq.on('timeout', () => process.exit(1));
    rq.end();`], { timeout: 15000 });
  return r.status === 0;
}

/** Everything MockServer will actually serve, as one string. */
function activeExpectations(): string {
  const r = spawnSync(NODE20, ['-e', `
    const http = require('http');
    const rq = http.request({ host: '127.0.0.1', port: 1080,
      path: '/mockserver/retrieve?type=active_expectations&format=json',
      method: 'PUT', timeout: 30000 }, (res) => {
        let d = ''; res.on('data', (c) => d += c);
        res.on('end', () => { process.stdout.write(d); });
      });
    rq.on('error', () => process.exit(1));
    rq.on('timeout', () => process.exit(1));
    // 64MB, DELIBERATELY. The active-expectation set runs to megabytes once sessions are
    // registered, and spawnSync truncates at 1MB by default, silently — every assertion then reads
    // a fragment and reports on whatever fell inside it. It did: "nothing writes into another
    // project" passed while 1,956 references to one sat past the cut.
    rq.end();`], { encoding: 'utf8', timeout: 45000, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout || '';
}

const UP = mockServerUp();
const loaded = UP ? spawnSync(NODE20, [LOADER], {
  encoding: 'utf8', timeout: 560000, cwd: REPO,
  env: { ...process.env, PRD_FILE: PRD, EPAM_PROJECT_CONFIG_DIR: PROJECT_DIR },
}) : null;
const out = loaded ? (loaded.stdout || '') + (loaded.stderr || '') : '';
const served = UP ? activeExpectations() : '';

const declaredSeams = Object.keys(
  JSON.parse(readFileSync(REGISTRY, 'utf8')).profiles
  || JSON.parse(readFileSync(REGISTRY, 'utf8'))).length;
const OTHER_PROJECTS = readdirSync(join(REPO, 'orchestrations/projects'))
  .filter((p) => p !== THIS_PROJECT);
const num = (re: RegExp) => { const m = re.exec(out); return m ? Number(m[1]) : null; };
const lineFor = (seam: string) => out.split('\n').find((l) => l.trim().startsWith(seam)) || '';

describe('the mock loader', () => {
  it('the fixtures are real: server up, project on disk, expectations registered', () => {
    // Skipping loudly beats a green suite that measured an absent server.
    expect(UP, 'MockServer is not reachable on :1080; start it before trusting this suite').toBe(true);
    expect(existsSync(PRD), 'the driving PRD is gone').toBe(true);
    expect(existsSync(CASSETTE), 'the driving cassette is gone').toBe(true);
    expect(declaredSeams, 'the registry declares no seams').toBeGreaterThan(10);
    expect(OTHER_PROJECTS.length, 'there is no second project, so nothing could be mistargeted')
      .toBeGreaterThan(0);
    expect(served.length, 'MockServer returned no expectations at all').toBeGreaterThan(500);
  }, 600_000);

  it('reports the seams it answered with an invented stand-in, with a count', () => {
    expect(out, 'the summary never mentions stand-ins, so an invented reply is indistinguishable '
      + 'from a recorded one').toMatch(/stand-in/i);
    expect(num(/STAND-IN (\d+)/i), 'no count of stand-ins is given').not.toBeNull();
  }, 600_000);

  it('names a real capture it could not serve, rather than silently replacing it', () => {
    // The most useful diagnostic there is: a recording EXISTS but was set aside. Hiding it sends
    // the reader hunting for a missing file that is sitting on disk.
    expect(out, 'the report never mentions set-aside captures in any form')
      .toMatch(/unusable|set aside|ends in prose/i);
  }, 600_000);

  it('accounts for every declared seam in some printed bucket', () => {
    const covered = num(/covered (\d+) seam/i);
    const stood = num(/STAND-IN (\d+)/i);
    // SHARED is a fourth TERMINAL outcome, not an annotation: such a seam leaves the loop having
    // been neither recorded nor stood in for. Omitting it is what made the total read 37 of 40.
    const shared = num(/SHARED (\d+)/i);
    const uncov = num(/UNCOVERED (\d+)/i);
    for (const [n, v] of Object.entries({ covered, stood, shared, uncov })) {
      expect(v, `no ${n} count printed in:\n${out.slice(0, 300)}`).not.toBeNull();
    }
    expect(covered! + stood! + shared! + uncov!,
      `${covered} + ${stood} + ${shared} + ${uncov} does not account for all ${declaredSeams} seams`)
      .toBe(declaredSeams);
  }, 600_000);

  it('THE FIXTURE: the driving recording really is a session that made tool calls', () => {
    const doc = JSON.parse(readFileSync(CASSETTE, 'utf8'));
    const turns = Array.isArray(doc)
      ? doc : Object.keys(doc).filter((k) => /^\d+$/.test(k)).map((k) => doc[k]);
    expect(turns.length, 'the cassette is single-turn; this proves nothing').toBeGreaterThan(1);
    expect(turns.reduce((n: number, t: any) => n + ((t && t.toolCalls) || []).length, 0),
      'the cassette carries no tool calls at all').toBeGreaterThan(0);
  }, 30_000);

  it('serves that seam from its recording, not set aside as prose', () => {
    const line = lineFor(SEAM);
    expect(line, `${SEAM} appears nowhere in the report`).not.toBe('');
    expect(line, `${SEAM} was set aside though its recording carries the tool calls that do the `
      + `work:\n  ${line}`).not.toMatch(/prose|ends in prose/i);
    expect(line, 'the entry does not identify a multi-turn replay').toMatch(/turns?, \d+ tool call/i);
  }, 600_000);

  it('THE DEFECT: nothing served writes into another project\'s directory', () => {
    const offenders = OTHER_PROJECTS
      .filter((p) => served.includes(`orchestrations/projects/${p}/`));
    expect(offenders,
      `replayed calls act on ${offenders.join(', ')} — a project this rehearsal is not running`)
      .toEqual([]);
  }, 600_000);

  it('and does name THIS project, so the rewrite happened rather than the path vanishing', () => {
    // The failure this guards: satisfying the assertion above by stripping paths entirely, which
    // leaves the write nowhere to land and reproduces the original symptom exactly.
    expect(served, `no served call references ${THIS_PROJECT} at all`)
      .toContain(`orchestrations/projects/${THIS_PROJECT}/`);
  }, 600_000);

  it('and says so, so a reader can see a capture was rewritten before it was served', () => {
    expect(out, 'paths were retargeted with no mention in the report').toMatch(/retargeted/i);
  }, 600_000);
});
