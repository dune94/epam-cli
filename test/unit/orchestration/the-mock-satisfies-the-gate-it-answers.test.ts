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
import { describe, it, expect } from 'vitest';

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
