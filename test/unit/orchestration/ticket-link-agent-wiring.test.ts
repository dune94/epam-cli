/**
 * The ticket-link agent must actually be CALLED, and its findings must reach the agents
 * that would otherwise assume.
 *
 * A profile that nothing invokes is documentation. The links were already being extracted
 * at ingest before this wiring existed, and they still reached nobody — which is the same
 * failure as destroying them, one step later.
 *
 * WHAT THIS PREVENTS
 * ------------------
 * On the live ticket, two vendor documentation links sat in the comment thread for six
 * weeks. Between them they established that the SDK callback the story depends on takes NO
 * argument (the story's own verification criteria assert the opposite), and that the
 * feature is configured in the vendor's UI rather than in application code. Two runs were
 * spent building against both assumptions, and a writer was failed for not doing something
 * the SDK cannot do.
 *
 * So the contract is not "the agent exists". It is: the links reach it, it is schema-bound
 * so it cannot answer in prose, its findings are persisted, and they are injected as
 * EVIDENCE into the prompts of the agents that would otherwise guess.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TAG_TO_TOOL } = require(join(ROOT, 'orchestrations/scripts/lib/agent-output-schema.js'));

describe('the agent is schema-bound — it cannot answer in prose', () => {
  it('a tool definition exists and is exported through TOOL_DEFINITIONS', () => {
    expect(spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS, 'no schema for the ticket-link agent').toBeTruthy();
  });

  it('the tag is registered so the validator can enforce the shape', () => {
    expect(TAG_TO_TOOL.TICKET_LINKS).toBeTruthy();
    expect(TAG_TO_TOOL.TICKET_LINKS.tool).toBe('TOOL_TICKET_LINKS');
  });

  it('each link result must carry a classification and a relevance judgement', () => {
    const items = spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS.parameters.properties.links.items;
    expect(items.required).toEqual(expect.arrayContaining(['url', 'classification', 'relevant']));
  });

  it('a reachable document must be QUOTED, not summarised', () => {
    const props = spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS.parameters.properties.links.items.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['quotes']));
    expect(JSON.stringify(props.quotes), 'a paraphrase is how a wrong contract propagates')
      .toMatch(/verbatim|quote/i);
  });

  it('a contradiction with the story is a first-class field, not buried in prose', () => {
    const props = spec.TOOL_DEFINITIONS.TOOL_TICKET_LINKS.parameters.properties.links.items.properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['contradictsStory']));
  });
});

describe('the agent is invoked with the links ingest recovered', () => {
  it('a deriver exists and is exported', () => {
    expect(typeof spec.reviewTicketLinks).toBe('function');
  });

  it('it is called during the spec pass', () => {
    expect(SRC, 'the agent has a profile and a schema but nothing calls it').toMatch(/reviewTicketLinks\(/);
  });

  it('it is passed the links the ingest carried onto the story', () => {
    expect(SRC).toMatch(/ticketLinks/);
  });

  it('it is given the story so it can judge relevance, not just the URL', () => {
    const i = SRC.indexOf('await reviewTicketLinks(');
    expect(i, 'reviewTicketLinks is never awaited').toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 400)).toMatch(/story/);
  });
});

describe('findings are persisted and reach the agents that would otherwise assume', () => {
  it('persisted onto the story for replay and audit', () => {
    expect(SRC).toMatch(/specification\.referencedDocs|story\.referencedDocs/);
  });

  it('injected into a prompt as evidence — not merely stored', () => {
    expect(
      SRC,
      'storing the findings and never showing them to an agent repeats the original failure',
    ).toMatch(/referencedDocsBlock|REFERENCED DOCUMENTATION/);
  });

  it('a contradiction is surfaced prominently, not as a footnote', () => {
    expect(SRC).toMatch(/CONTRADICT/i);
  });
});

describe('it never blocks a run', () => {
  it('the call is guarded so an unreachable network cannot halt the spec pass', () => {
    const i = SRC.indexOf('reviewTicketLinks(');
    const around = SRC.slice(Math.max(0, i - 500), i + 600);
    expect(
      around,
      'a documentation lookup is evidence-gathering, not a gate — it must degrade, not abort',
    ).toMatch(/try\s*\{|catch/);
  });

  it('a story with no links does not invoke the agent at all', () => {
    expect(SRC).toMatch(/ticketLinks[^\n]*length|length[^\n]*ticketLinks/);
  });
});

describe('the agent profile exists in every profile file the pipeline restores from', () => {
  for (const f of ['profiles.json', 'profiles.json.original', 'profiles.canonical.json']) {
    it(`${f} defines ticket-link-agent`, () => {
      const p = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents', f), 'utf8'));
      expect(p['ticket-link-agent']).toBeTruthy();
    });
  }
});
