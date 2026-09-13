/**
 * THE STAND-IN MUST PASS THE GATE THE REAL AGENT PASSES.
 *
 * The free rehearsal exists so the mint can be exercised without paying. That only holds if the
 * mock's own answer satisfies the mint's contract — and four times running it did not, each one
 * reading in the log exactly like a pipeline defect:
 *
 *   1. `kind` filled with prose, so the mint refused "unrecognised kind"
 *   2. `name` filled with prose containing spaces — "not a plain kebab-case identifier"
 *   3. `rationale` 19 characters against a declared minimum of 24 — "says nothing"
 *   4. the name suffixed after the seam, routing nowhere — "resolves to no seam"
 *
 * Each cost a rehearsal to find. All four are one assertion: put the stand-in through
 * isUsableProposal — the mint's own gate, not a copy of it — and the harness can never again
 * fail the run it was built to make free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';

// A TEST MUST NOT DEPEND ON THE SHELL THAT LAUNCHED IT. This passed only when the caller happened
// to export PRD_FILE; without it projectStories() is empty, every per-story stand-in loses its
// story, and the assertion fails for a reason that has nothing to do with what it tests. The
// project is DISCOVERED — the first one declaring stories — so no path is written down here.
//
// The AUTHORED PRD, not the runtime one: prd.json is what a run restores from prd.authored.json
// (pre-run-reset) or from PRD_CANONICAL (greenfield), and it is not tracked — a checkout may hold
// none at all, which left this test red for a reason that had nothing to do with what it tests.
const ROOT = path.join(__dirname, '../../../');
const PROJECTS = path.join(ROOT, 'orchestrations/projects');
const withStories = fs.readdirSync(PROJECTS)
  .flatMap((d) => {
    const out = [path.join(PROJECTS, d, 'prd.authored.json')];
    try {
      const m = fs.readFileSync(path.join(PROJECTS, d, 'config.env'), 'utf8').match(/^PRD_CANONICAL=(.+)$/m);
      if (m) out.push(path.isAbsolute(m[1].trim()) ? m[1].trim() : path.join(ROOT, m[1].trim()));
    } catch { /* a project with no config declares no canonical */ }
    return out;
  })
  .find((f) => {
    try { return (JSON.parse(fs.readFileSync(f, 'utf8')).stories || []).length > 0; } catch { return false; }
  });
if (withStories) process.env.PRD_FILE = withStories;

const mock = require('../../../orchestrations/scripts/mock-expectations.js');
const roster = require('../../../orchestrations/scripts/lib/agent-roster.js');

describe('the mock satisfies the gate it answers', () => {
  it('the mint stand-in passes the mint\'s own usability gate', () => {
    const standIn = mock.contractStandIn('agent-mint');
    expect(standIn, 'the harness must produce a mint answer at all').toBeTruthy();

    const proposals = Array.isArray(standIn) ? standIn
      : (standIn.agents || standIn.projectAgents || [standIn]);
    expect(proposals.length, 'a stand-in proposing nothing proves nothing').toBeGreaterThan(0);

    for (const p of proposals) {
      // isUsableProposal returns a REASON when it refuses, and null when it accepts.
      expect(roster.isUsableProposal(p), `the mint refused its own stand-in: ${p && p.name}`)
        .toBeFalsy();
    }
  });

  it('a role-valued field is recognised however the contract words it', () => {
    // The property that broke this was worded in the plural — the one property the function
    // exists to recognise was the one its regex missed.
    expect(mock.expectsARole({ description: 'MUST be one of the offered roles, verbatim.' })).toBe(true);
    expect(mock.expectsARole({ description: 'The role that owns this story.' })).toBe(true);
    expect(mock.expectsARole({ description: 'One sentence: why this owns this story.' })).toBe(false);
  });

  it('the name the mint registers is the name the assigner offers', () => {
    // Two stand-ins, one registry: the assigner cannot offer a role the mint never minted.
    const minted = mock.standInRoleName('implementer');
    expect(minted, 'no implementer name routes — the registry declares one').toBeTruthy();
    expect(minted).toMatch(roster.ROLE_NAME_RE);
    expect(roster.isUsableProposal({
      name: minted, kind: 'implementer', systemPrompt: 'x', rationale: 'y'.repeat(40),
      codeline: '*',
    }), `the minted implementer name is not usable: ${minted}`).toBeFalsy();
  });

  it('the assigner offers exactly the role the mint mints', () => {
    // Not "a role of the right kind" — THE role. Expectations are registered before the run, so
    // the roster is empty on disk and any independently-derived name is a guess. Both stand-ins
    // read the one answer, so they cannot disagree.
    const mint = mock.contractStandIn('agent-mint');
    const minted = (Array.isArray(mint) ? mint : (mint.agents || [mint])).map((a: any) => a.name);
    expect(minted.length, 'the mint must mint something for this to mean anything').toBeGreaterThan(0);

    const assigned = mock.contractStandIn('role-assigner');
    const rows = Array.isArray(assigned) ? assigned : [assigned];
    expect(rows.length, 'the assigner must answer for at least one story').toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.storyId, 'an assignment that names no story answers for none').toBeTruthy();
      expect(minted, `story ${row.storyId} was assigned a role the mint never minted`)
        .toContain(row.agentRole);
    }
  });
});

/**
 * A VERDICT SEAM'S STAND-IN SPEAKS THE VOCABULARY ITS JUDGE DECLARES.
 *
 * The verdict stand-in answered `pass` for every verdict-kind seam. Both roster reviews are judged
 * against TOOL_ROSTER_REVIEW, whose enum is sound | defects_found | nothing_to_review — so the
 * stand-in was refused ("does not allow — declared values are…"), read as a review that did not
 * look, retried three times identically, and the mint aborted. Found 2026-09-13 by the £0
 * greenfield integration test, one stage past the sizing defect it had just uncovered.
 *
 * The contract now names the tag a verdict is judged under; the stand-in reads the vocabulary
 * from that tag's live tool definition and is put through the same validator the pipeline uses.
 */
describe('a verdict stand-in satisfies the validator its seam is judged by', () => {
  const schema = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const contracts = schema.declaredContracts() as Record<string, any>;
  const tagged = Object.entries(contracts).filter(([, c]) => c.kind === 'verdict' && c.tag);

  it('the roster reviews declare the tag they are judged under', () => {
    for (const seam of ['roster-review', 'project-roster-review']) {
      expect(contracts[seam] && contracts[seam].tag, `${seam} declares no tag`).toBeTruthy();
    }
  });

  for (const [seam, c] of tagged) {
    it(`${seam}: the stand-in passes validateTaggedOutput for <${c.tag}>`, () => {
      const standIn = mock.contractStandIn(seam);
      expect(standIn, 'no stand-in').toBeTruthy();
      const r = schema.validateTaggedOutput(c.tag, standIn);
      expect(r.ok, r.reason).toBe(true);
    });
  }
});

/**
 * THE DISCOVERY STAND-IN NAMES THE REPOSITORIES THIS RUN ACTUALLY HAS.
 *
 * codeline-discovery's parse refuses an answer that selects no codeline, or one whose path is not
 * an existing git repository. The declared stand-in filled `codelines` with [] (a plural key is a
 * list), and the only recording of the seam came from another estate, whose paths do not exist
 * here — so the £0 brownfield run was refused three times at its first model stage (2026-09-13).
 * The repositories a tracker run scopes are the ones under JIRA_CODELINE_ROOT — the run's own
 * declaration — so the stand-in selects exactly those, with their real absolute paths.
 */
describe('the discovery stand-in names the repositories this run has', () => {
  const { mkdtempSync, mkdirSync, existsSync: exists } = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  it('selects every git repository under JIRA_CODELINE_ROOT, by real absolute path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cl-root-'));
    for (const n of ['alpha', 'beta']) { mkdirSync(path.join(root, n)); execFileSync('git', ['-C', path.join(root, n), 'init', '-q']); }
    mkdirSync(path.join(root, 'not-a-repo'));
    const prev = process.env.JIRA_CODELINE_ROOT; process.env.JIRA_CODELINE_ROOT = root;
    try {
      const standIn = mock.contractStandIn('codeline-discovery');
      const picked = (standIn && standIn.codelines) || [];
      expect(picked.map((c: any) => c.name).sort()).toEqual(['alpha', 'beta']);
      for (const c of picked) {
        expect(path.isAbsolute(c.path)).toBe(true);
        expect(exists(path.join(c.path, '.git')), `${c.path} is not a git repository`).toBe(true);
      }
    } finally { if (prev === undefined) delete process.env.JIRA_CODELINE_ROOT; else process.env.JIRA_CODELINE_ROOT = prev; }
  });
  it('with no codeline root declared, the list stays empty — nothing is invented', () => {
    const prev = process.env.JIRA_CODELINE_ROOT; delete process.env.JIRA_CODELINE_ROOT;
    try { expect((mock.contractStandIn('codeline-discovery') || {}).codelines).toEqual([]); }
    finally { if (prev !== undefined) process.env.JIRA_CODELINE_ROOT = prev; }
  });
});

/**
 * A TRACKER RUN'S STORIES COME FROM THE TRACKER — before the PRD exists.
 *
 * Under JIRA_PIPELINE=1 the PRD is synthesised during the run, after the AC gate has already
 * called a model, so registration keyed on a PRD had nothing to key on and refused. The stand-ins
 * now ask the same fetcher the ingest uses, and register a ticket under every id the AC gate may
 * give it: its own key (a spanning story) and `<key>-<codeline>` for each repository in the estate
 * (a split story). Driven through the real stub tracker and the real fetcher.
 */
describe("a tracker run's stories come from the tracker", () => {
  const { spawn } = require('node:child_process');
  const { mkdtempSync, mkdirSync, readFileSync: rf, existsSync: ex } = require('node:fs');
  const { execFileSync: exec } = require('node:child_process');
  const os = require('node:os');
  let jira: any; let port = '';
  beforeAll(async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'jira-')), 'jira.out');
    jira = spawn(process.execPath, [path.join(ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js'), 'TRK-7', 'a summary', 'a description'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the stub tracker never reported a port')), 15_000);
      jira.stdout.on('data', (d: Buffer) => { buf += d; const m = buf.match(/LISTENING:(\d+)/); if (m) { port = m[1]; clearTimeout(t); resolve(); } });
    });
    void out; void rf; void ex;
  }, 20_000);
  afterAll(() => { try { jira.kill('SIGKILL'); } catch { /* gone */ } });

  it('registers the ticket under its key and under <key>-<codeline> for every estate repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'estate-'));
    mkdirSync(path.join(root, 'hello-svc')); exec('git', ['-C', path.join(root, 'hello-svc'), 'init', '-q']);
    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string | undefined) => { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    set('JIRA_PIPELINE', '1'); set('JIRA_URL', `http://127.0.0.1:${port}`); set('JIRA_EMAIL', 'mock@test.com'); set('JIRA_TOKEN', 'mock-token');
    set('JIRA_PROJECT_KEY', 'TRK'); set('JIRA_STATUS_FILTER', 'To Do'); set('JIRA_CODELINE_ROOT', root); set('PRD_FILE', path.join(root, 'no-prd.json'));
    try {
      // Every module-level cache is per process: a fresh require sees this environment.
      delete require.cache[require.resolve('../../../orchestrations/scripts/mock-expectations.js')];
      const fresh = require('../../../orchestrations/scripts/mock-expectations.js');
      const rows = fresh.contractStandIn('role-assigner');
      const ids = (Array.isArray(rows) ? rows : [rows]).map((r: any) => r.storyId).sort();
      const { deriveCodelineName } = require('../../../orchestrations/scripts/lib/codeline-name.js');
      expect(ids).toEqual(['TRK-7', `TRK-7-${deriveCodelineName('hello-svc')}`].sort());
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
});

/**
 * THE SPECIALISER STAND-IN ANSWERS AS THE MODEL DID: IT ADDS THE MINTED AGENTS.
 *
 * Run 5 (2026-09-13, $0.34) wrote "0 specialised, 2 added" and the engine refused both minted
 * agents for a digest it had not computed. The stand-in had always written an empty delta, so the
 * £0 test never reached that path. The stand-in now adds every agent the mint stand-in mints, each
 * its own ancestor — and the delta is put through the engine's own compose and contract check.
 */
describe('the specialiser stand-in adds the minted agents and the engine accepts them', () => {
  it('composes through composeFromDelta and passes checkRoster', () => {
    const { mkdtempSync: mk, writeFileSync: wf } = require('node:fs');
    const os = require('node:os');
    const rosterLib = require('../../../orchestrations/scripts/lib/project-roster.js');
    const delta = mock.contractStandIn('roster-specialiser');
    const names = Object.keys((delta && delta.agents) || {});
    expect(names.length, 'the stand-in delta adds nothing — it does not answer as a model does').toBeGreaterThan(0);
    for (const n of names) expect(delta.agents[n].ancestor, `${n} is not its own ancestor`).toBe(n);
    // The mint registers what it minted before the specialiser runs; the fixture does the same.
    const d = mk(path.join(os.tmpdir(), 'stand-in-delta-'));
    const byKind: Record<string, string[]> = {};
    for (const n of names) (byKind[delta.agents[n].kind || 'implementer'] ||= []).push(n);
    wf(path.join(d, 'project-roles.json'), JSON.stringify({ roles: byKind.implementer || [] }));
    wf(path.join(d, 'project-investigators.json'), JSON.stringify({ investigators: byKind.investigator || [] }));
    const prev = process.env.EPAM_PROJECT_CONFIG_DIR; process.env.EPAM_PROJECT_CONFIG_DIR = d;
    try {
      const canon = { 'team-lead-review': 'a canonical persona' };
      const { roster: r, added } = rosterLib.composeFromDelta(delta, canon);
      expect(added).toBe(names.length);
      const check = rosterLib.checkRoster(r, canon);
      expect(check.ok, `the engine refused the stand-in delta: ${check.reason}`).toBe(true);
    } finally { if (prev === undefined) delete process.env.EPAM_PROJECT_CONFIG_DIR; else process.env.EPAM_PROJECT_CONFIG_DIR = prev; }
  });
});
