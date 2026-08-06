/**
 * Links in Jira comments must survive ingest.
 *
 * WHAT WAS LOST
 * -------------
 * normalizeIssue flattened Atlassian Document Format by reading only
 * `content[].content[].text`. In ADF a hyperlink is TEXT plus a `link` MARK carrying the
 * href, and a pasted URL is often an `inlineCard` node whose url lives in `attrs.url` with
 * no text child at all. So every URL in every comment was destroyed at ingest — the text
 * survived, the address did not.
 *
 * Live, AMSD-2041: twelve comments, ten of them coordination noise, and two links that
 * settled the entire ticket —
 *
 *   - the vendor's live-preview implementation guide, which states the SDK callback takes
 *     NO argument and the app must re-fetch. The pipeline's verification criteria assert
 *     the opposite, and a previous run failed the writer for not doing the impossible.
 *   - the vendor's custom-preview-URL guide, which states the configuration is done in the
 *     vendor UI and needs no application code at all — corroborating a stakeholder comment
 *     that the pipeline also discarded.
 *
 * Both rendered as "Updated Contentstack docs link - " with nothing after it. Two runs were
 * spent building against assumptions the ticket itself refuted.
 *
 * Comments themselves are mostly coordination noise and are deliberately NOT fed to the
 * code-search query — rare, meaningless tokens (release names, "cc", "please confirm") are
 * amplified by IDF and would drag the search away from real code. It is the LINKS that
 * carry signal, and they are what these tests protect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const JIRA_CLIENT = require.resolve('../../../orchestrations/scripts/lib/jira-client');

function freshClient() {
  vi.resetModules();
  const prev = { ...process.env };
  Object.assign(process.env, {
    JIRA_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_TOKEN: 't',
  });
  const mod = require(JIRA_CLIENT);
  process.env = prev;
  return mod;
}

/** An issue shaped exactly like the real API response, with ADF comment bodies. */
function issueWithComments(comments: any[]) {
  return {
    key: 'T-1',
    fields: {
      summary: 'A ticket',
      description: 'plain description',
      status: { name: 'To Do' },
      labels: [],
      components: [{ name: 'GO' }, { name: 'MX' }],
      issuetype: { name: 'Story' },
      comment: { comments },
    },
  };
}

/** ADF: text carrying a link mark — how a hyperlink actually appears. */
const adfLinkComment = (href: string, text = 'docs link') => ({
  author: { displayName: 'A Person' },
  created: '2026-07-27T00:00:00.000Z',
  body: {
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Updated ' },
        { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] },
      ],
    }],
  },
});

/** ADF: a pasted URL becomes an inlineCard with no text child at all. */
const adfInlineCard = (url: string) => ({
  author: { displayName: 'A Person' },
  created: '2026-07-28T00:00:00.000Z',
  body: { content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url } }] }] },
});

describe('comment links survive ingest', () => {
  let jira: any;
  beforeEach(() => { jira = freshClient(); });

  it('THE LOSS: a link mark yields its href, not just the anchor text', () => {
    const url = 'https://vendor.example/docs/live-preview-guide';
    const out = jira.normalizeIssue(issueWithComments([adfLinkComment(url)]));
    expect(
      (out.commentLinks || []).map((l: any) => l.url),
      'the href was dropped — this is how two vendor docs that refuted the spec were destroyed',
    ).toContain(url);
  });

  it('a pasted URL (inlineCard, no text child) is captured', () => {
    const url = 'https://vendor.example/docs/custom-preview-urls';
    const out = jira.normalizeIssue(issueWithComments([adfInlineCard(url)]));
    expect((out.commentLinks || []).map((l: any) => l.url)).toContain(url);
  });

  it('a bare URL written as plain text is captured', () => {
    const c = {
      author: { displayName: 'P' }, created: '2026-07-01T00:00:00.000Z',
      body: { content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see https://vendor.example/x for detail' }] }] },
    };
    expect((jira.normalizeIssue(issueWithComments([c])).commentLinks || []).map((l: any) => l.url))
      .toContain('https://vendor.example/x');
  });

  it('links from the DESCRIPTION are captured too, not only comments', () => {
    const iss = issueWithComments([]);
    (iss.fields as any).description = {
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'spec', marks: [{ type: 'link', attrs: { href: 'https://vendor.example/spec' } }] }] }],
    };
    expect((jira.normalizeIssue(iss).commentLinks || []).map((l: any) => l.url))
      .toContain('https://vendor.example/spec');
  });

  it('each link carries provenance — which comment, by whom, when', () => {
    const out = jira.normalizeIssue(issueWithComments([adfLinkComment('https://vendor.example/a')]));
    const link = (out.commentLinks || [])[0];
    expect(link.author).toBe('A Person');
    expect(link.created).toMatch(/^2026-07-27/);
    expect(link.context, 'no surrounding text means a human cannot judge relevance').toMatch(/Updated/);
  });

  it('duplicate URLs across comments are recorded once', () => {
    const u = 'https://vendor.example/same';
    const out = jira.normalizeIssue(issueWithComments([adfLinkComment(u), adfInlineCard(u)]));
    expect((out.commentLinks || []).filter((l: any) => l.url === u).length).toBe(1);
  });

  it('a ticket with no links yields an empty list, never undefined', () => {
    expect(jira.normalizeIssue(issueWithComments([])).commentLinks).toEqual([]);
  });

  it('malformed ADF does not throw — ingest must not die on a comment', () => {
    const junk = [{ body: null }, { body: { content: 'not-an-array' } }, {}];
    expect(() => jira.normalizeIssue(issueWithComments(junk))).not.toThrow();
  });
});

/**
 * POLICY REVERSED 2026-08-06. This suite asserted that comment text is preserved "so scope
 * statements are not lost", using the very sentence that turned out to be the danger:
 * "no code changes are needed and its more of configure and use".
 *
 * That sentence is an unverified guess, posted while waiting for a vendor demo. It is also
 * false for this codeline — the vendor guide requires an SDK install, an init() call and
 * onEntryChange wiring, and none of it exists in src/. Preserving it "for judgement" put an
 * opinion into the pipeline's inputs where an agent could adopt it as fact and conclude the
 * story needs no code, against both the documentation and the repository.
 *
 * A comment's LINK is evidence: it names a document that can be fetched, quoted and checked.
 * A comment's PROSE is not. So prose now enters only when it accompanies a link, where it
 * serves as provenance — and is already carried on the link record as `context`.
 */
describe('opinion in comment prose is not an input', () => {
  let jira: any;
  beforeEach(() => { jira = freshClient(); });

  it('a linkless opinion does not reach the pipeline', () => {
    const c = {
      author: { displayName: 'P' }, created: '2026-07-22T00:00:00.000Z',
      body: { content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no code changes are needed' }] }] },
    };
    const out = jira.normalizeIssue(issueWithComments([c]));
    expect(
      (out.comments || []).map((x: any) => x.text).join(' '),
      'a guess contradicted by the vendor docs and the repository reached the agents as ticket content',
    ).not.toMatch(/no code changes/);
  });
});

describe('components survive ingest — the tracker\'s own statement of scope', () => {
  let jira: any;
  beforeEach(() => { jira = freshClient(); });

  it('components are returned', () => {
    expect(jira.normalizeIssue(issueWithComments([])).components).toEqual(['GO', 'MX']);
  });
});

/**
 * OPINIONS IN COMMENTS MUST NOT STEER THE PIPELINE.
 *
 * A Jira thread is where people speculate. On AMSD-2041 one comment read:
 *
 *   "Its possible, no code changes are needed and its more of configure and use."
 *
 * That is a guess, offered while waiting for a vendor demo. The vendor's own implementation
 * guide and the repository both contradict it: @contentstack/live-preview-utils is not
 * installed, `live_preview` appears nowhere in src/, and the guide requires an SDK install,
 * an init() call and onEntryChange wiring. Had an agent adopted that sentence as fact, the
 * pipeline would have concluded the story needs no code — from a comment, against the
 * evidence.
 *
 * So comment PROSE is not an input. A link is: it points at a document that can be fetched,
 * quoted and checked. The text around a link survives only as provenance — why it was
 * posted — and is already carried on the link record itself.
 *
 * The contract stays the description and the acceptance criteria; the evidence stays the
 * linked documents. Neither is a colleague's opinion mid-thread.
 */
describe('only comments carrying a link enter the pipeline', () => {
  const { normalizeIssue } = require('../../../orchestrations/scripts/lib/jira-client.js');

  const adf = (text: string, href?: string) => ({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: href
        ? [{ type: 'text', text }, { type: 'text', text: 'doc', marks: [{ type: 'link', attrs: { href } }] }]
        : [{ type: 'text', text }],
    }],
  });

  const issue = {
    fields: {
      summary: 's',
      description: adf('the real requirement'),
      comment: {
        comments: [
          { author: { displayName: 'Opinionated' }, created: '2026-07-01T00:00:00.000+0000',
            body: adf('Its possible, no code changes are needed and its more of configure and use.') },
          { author: { displayName: 'Evidence' }, created: '2026-07-02T00:00:00.000+0000',
            body: adf('the implementation guide is here: ', 'https://vendor.test/docs/guide') },
        ],
      },
    },
  };

  it('THE OPINION IS DROPPED', () => {
    const n = normalizeIssue(issue);
    expect(
      JSON.stringify(n.comments),
      'an unverified guess reached the agents as if it were ticket content',
    ).not.toMatch(/no code changes are needed/);
  });

  it('the comment carrying a link is kept', () => {
    const n = normalizeIssue(issue);
    expect(n.comments.length).toBe(1);
    expect(n.comments[0].author).toBe('Evidence');
  });

  it('the link itself is unaffected, with its provenance', () => {
    const n = normalizeIssue(issue);
    expect(n.commentLinks.map((l: any) => l.url)).toContain('https://vendor.test/docs/guide');
    const link = n.commentLinks[0];
    expect(link.author).toBe('Evidence');
    expect(link.context, 'the link loses the sentence explaining why it was posted').toContain('implementation guide');
  });

  it('a thread of pure opinion yields no comments at all', () => {
    const n = normalizeIssue({ fields: { summary: 's', description: adf('d'), comment: { comments: [
      { author: { displayName: 'A' }, body: adf('I think we should wait for a demo.') },
      { author: { displayName: 'B' }, body: adf('Agreed, lets reassess next PI.') },
    ] } } });
    expect(n.comments).toEqual([]);
  });

  it('the description is untouched by any of this', () => {
    const n = normalizeIssue(issue);
    expect(n.description).toContain('the real requirement');
  });
});
