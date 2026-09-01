/**
 * "COVERED 9, UNCOVERED 0" WHILE 31 SEAMS ANSWER WITH AN INVENTION.
 *
 * mock-expectations.js states its own standard in its header: a body is "a recording of what a
 * model really said, or the seam is skipped and reported as uncovered rather than answered with
 * something invented". The loader honours the first half and hides the second. It sorts every seam
 * into six buckets — covered, stood-in, unusable, stale, uncovered, foreign — and prints two.
 *
 * So a rehearsal of 40 declared seams reported:
 *
 *   covered 9 seam(s) from real captures
 *   UNCOVERED 0 — these answer {} and will fail their contract
 *
 * Both true, and together they read as complete coverage. The other 31 were answered by contract
 * stand-ins: synthetic replies carrying the declared fields and nothing else. For most seams that
 * is survivable. For a seam that DELIVERS BY WRITING A FILE it is not — roster-specialiser writes
 * its roster with bash, a stand-in leaves no file behind, and the contract refuses it three
 * attempts running. The pipeline then halts at mint with "the agent wrote no roster", naming a
 * destination rather than the cause, three stages downstream of a decision this summary made
 * silently.
 *
 * A count whose method is not stated implies completeness it does not have. Every bucket is
 * reported, and the buckets must add up to the number of seams declared — otherwise a seam went
 * somewhere nobody printed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LOADER = join(REPO, 'orchestrations/scripts/mock-expectations.js');
const PRD = join(REPO, 'orchestrations/projects/mock3/prd.json');
const REGISTRY = join(REPO, 'orchestrations/agents/invocation-profiles.json');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

/** Is MockServer actually up? The loader resets it, so without one this measures nothing. */
function mockServerUp(): boolean {
  const r = spawnSync(NODE20, ['-e', `
    const http = require('http');
    const rq = http.request({ host: '127.0.0.1', port: 1080, path: '/mockserver/status',
      method: 'PUT', timeout: 4000 }, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); });
    rq.on('error', () => process.exit(1));
    rq.on('timeout', () => process.exit(1));
    rq.end();`], { timeout: 15000 });
  return r.status === 0;
}

const UP = mockServerUp();
const declaredSeams = (() => {
  const j = JSON.parse(require('node:fs').readFileSync(REGISTRY, 'utf8'));
  return Object.keys(j.profiles || j).length;
})();

function load() {
  const r = spawnSync(NODE20, [LOADER], {
    encoding: 'utf8', timeout: 560000, cwd: REPO,
    env: { ...process.env, PRD_FILE: PRD },
  });
  return (r.stdout || '') + (r.stderr || '');
}

const out = UP ? load() : '';

describe('the mock reports every seam it answered for', () => {
  it('MockServer is up and the registry declares seams — else this proves nothing', () => {
    // Skipping loudly beats a green test that measured an absent server.
    expect(UP, 'MockServer is not reachable on :1080; start it before trusting this suite').toBe(true);
    expect(declaredSeams, 'the registry declares no seams').toBeGreaterThan(10);
    expect(existsSync(PRD), 'the driving PRD is gone').toBe(true);
  }, 30_000);

  it('THE DEFECT: seams answered by a contract stand-in are reported, with a count', () => {
    expect(out, 'the summary never mentions stand-ins, so an invented reply is indistinguishable '
      + 'from a recorded one').toMatch(/stand-in/i);
    expect(out, 'no count of stand-ins is given').toMatch(/\b\d+\b[^\n]*stand-in|stand-in[^\n]*\b\d+\b/i);
  }, 600_000);

  it('every declared seam is accounted for in some printed bucket', () => {
    // The property that makes the report trustworthy: nothing falls into a bucket nobody prints.
    const num = (re: RegExp) => { const m = re.exec(out); return m ? Number(m[1]) : null; };
    const covered = num(/covered (\d+) seam/i);
    const stood = num(/STAND-IN (\d+)/i);
    // SHARED is a fourth TERMINAL outcome, not an annotation: such a seam leaves the loop having
    // been neither recorded nor stood in for. Omitting it is what made the total read 37 of 40.
    const shared = num(/SHARED (\d+)/i);
    const uncov = num(/UNCOVERED (\d+)/i);
    expect(covered, `no covered count in:\n${out.slice(0, 300)}`).not.toBeNull();
    expect(stood, 'no stand-in count printed').not.toBeNull();
    expect(uncov, 'no uncovered count printed').not.toBeNull();
    expect(shared, "no shared count printed").not.toBeNull();
    expect(covered! + stood! + shared! + uncov!,
      `${covered} + ${stood} + ${shared} + ${uncov} does not account for all ${declaredSeams} declared seams`)
      .toBe(declaredSeams);
  }, 600_000);

  it('a real capture set aside as unusable is named, not silently replaced', () => {
    // The most useful diagnostic of all: a recording EXISTS but could not be served. Hiding it
    // sends the reader looking for a missing file that is sitting on disk.
    expect(out, 'the report never mentions set-aside captures in any form')
      .toMatch(/unusable|set aside|ends in prose/i);
  }, 600_000);
});
