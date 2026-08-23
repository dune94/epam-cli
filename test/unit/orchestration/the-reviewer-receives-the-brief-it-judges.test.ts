/**
 * THE REVIEWER RECEIVES THE BRIEF IT IS ASKED TO JUDGE.
 *
 * Live 2026-08-23, metrolinx AMSD-2041. The roster reviewer reported every minted agent's brief as
 * "entirely empty — no scope, no files, no deliverables" and blocked the roster twice. It was
 * right about the text it was given, and the text was wrong:
 *
 *     --- contentstack-livepreview-engineer  [implementer]
 *
 *
 *     THE CODELINES THESE BRIEFS DESCRIBE, ...
 *
 * A header, then nothing. Meanwhile the mint had written a 2,310-character brief for that agent.
 *
 * THE CAUSE, spec-mode-runner.js:4415:
 *
 *     const brief = (profiles && profiles[m.name]) || '';
 *
 * `profiles` is loaded from orchestrations/agents/profiles.json, which holds the 57 canonical
 * agents and none of the ones just minted — their briefs are written to the PROJECT's own
 * agent-profiles.json. Every lookup missed, and `|| ''` turned the miss into an empty string that
 * is indistinguishable from an agent that genuinely has no brief.
 *
 * WHY NO TEST CAUGHT IT. Five test files touch reviewRoster or the roster-review template. Every
 * one asserts the CONTAINER — that the template declares __BRIEF_BLOCK__, that an empty roster is
 * not approved, that a failed call is not read as approval, that the prompt lives in a file. None
 * asserts the CONTENT arrives. The reviewer ran, produced findings and blocked the roster, so
 * every observable said "wired".
 *
 * This asserts the payload: the brief text a minted agent actually has must appear in the block
 * the reviewer is handed. It is the same shape as the tool-grant and ladder failures found the
 * same day — declared and never delivered — and the same shape of test that finally caught those.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spec = require(RUNNER);

/** What the mint produces: an agent, and its brief held wherever the mint puts it. */
const MINTED = [{
  name: 'contentstack-livepreview-engineer',
  kind: 'implementer',
  codeline: 'metrolinx',
}];

const BRIEF = 'You are the Contentstack Live Preview implementer for the metrolinx codebase. '
  + 'You implement AMSD-2041: Live Preview of draft CMS content for the Homepage and Discover '
  + 'Article pages. Verify whether @contentstack/utils re-exports the Live Preview Utils SDK.';

describe('the brief reaches the block the reviewer reads', () => {
  it('renders the agent brief under its header, not an empty line', () => {
    expect(typeof spec.buildRosterBriefBlock,
      'spec-mode-runner exposes no way to build the block the reviewer receives, so what it is '
      + 'handed cannot be asserted at all').toBe('function');

    const block = spec.buildRosterBriefBlock(MINTED, {
      [MINTED[0].name]: BRIEF,
    });

    expect(block).toContain('--- contentstack-livepreview-engineer');
    expect(block, 'the reviewer was handed a header with no brief under it').toContain(BRIEF);
  });

  it('finds the brief wherever the mint actually wrote it', () => {
    // THE DEFECT ITSELF. The lookup read one profiles map; the mint writes minted briefs to the
    // project's own. A block builder that reads a single map cannot be given the other one.
    const block = spec.buildRosterBriefBlock(MINTED, {}, { [MINTED[0].name]: BRIEF });
    expect(block, 'a brief in the project profiles never reached the reviewer').toContain(BRIEF);
  });

  it('reads the project file in THE SHAPE THE MINT WRITES — nested under .profiles', () => {
    // The flat fixture above passed while the real artefact still rendered "NO BRIEF FOUND": the
    // project file is {runId, _what, profiles: {name: brief}} and the lookup read the top level.
    // The same failure one layer down, invisible to a fixture written from my own assumption and
    // caught only by running this against what a real run had just produced.
    const asTheMintWrites = {
      runId: '20260823T203151Z',
      _what: "This project's minted agent briefs.",
      profiles: { [MINTED[0].name]: BRIEF },
    };
    const block = spec.buildRosterBriefBlock(MINTED, {}, asTheMintWrites);
    expect(block, 'the nested project profiles never reached the reviewer').toContain(BRIEF);
  });

  it('SAYS SO when an agent has no brief anywhere — silence is not an empty brief', () => {
    // `|| ''` could not tell "this agent has no brief" from "this agent is not in this map", so a
    // plumbing failure and a real defect produced identical text and the reviewer blamed the
    // roster. The two must be distinguishable in what the reviewer reads.
    const block = spec.buildRosterBriefBlock(MINTED, {}, {});
    expect(block).toContain('--- contentstack-livepreview-engineer');
    expect(block, 'a missing brief rendered as blank, which reads as an empty brief')
      .toMatch(/NO BRIEF|not found|missing/i);
  });

  it('every minted agent appears, so none is silently dropped', () => {
    const many = [
      { name: 'a-engineer', kind: 'implementer', codeline: 'x' },
      { name: 'b-detective', kind: 'investigator', codeline: 'x' },
    ];
    const block = spec.buildRosterBriefBlock(many, { 'a-engineer': 'AAA', 'b-detective': 'BBB' });
    expect(block).toContain('AAA');
    expect(block).toContain('BBB');
  });
});
