/**
 * A TICKET'S LISTED ACCEPTANCE CRITERIA REACH THE PRD.
 *
 * Live 2026-10-01 (AMSD-2974, three ingests): the ticket carries seven Given/When/Then criteria as a
 * bullet list under the heading "5. Acceptance Criteria & Expected Outcome". The PRD received none,
 * and the AC gate reported "no acceptance criteria". normalizeIssue flattened the description
 * two levels deep — a list's items are three — so the section arrived empty; and the text
 * extractor wanted the heading to END at "acceptance criteria".
 *
 * EXECUTED: the real normalizeIssue on an Atlassian Document Format description of that shape (the
 * node types Jira returns; neutral wording).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jira = require(join(__dirname, '../../../orchestrations/scripts/lib/jira-client.js'));
const normalize = jira.normalizeIssue || jira._normalizeIssue;

const text = (t: string) => ({ type: 'text', text: t });
const para = (t: string) => ({ type: 'paragraph', content: [text(t)] });
const heading = (t: string) => ({ type: 'heading', attrs: { level: 3 }, content: [text(t)] });
const bullets = (items: string[]) => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [para(i)] })) });

const CRITERIA = [
  'Given a user completes an action, when the message appears, then it is visually distinct',
  'Given a screen reader is running, when the message appears, then it is announced',
  'Given the message is shown, when time passes, then the user has enough time to read it',
];
const issue = (doc: unknown) => ({ key: 'X-1', fields: { summary: 's', description: doc, labels: [], comment: { comments: [] } } });
const DOC = {
  type: 'doc', version: 1, content: [
    heading('1. Problem Statement'), para('Something is wrong.'),
    heading('5. Acceptance Criteria & Expected Outcome'), bullets(CRITERIA),
    heading('6. Designs & Assets'), para('Figma link: none yet'),
  ],
};

describe('a ticket\'s listed acceptance criteria reach the PRD', () => {
  it('normalizeIssue is reachable', () => {
    expect(typeof normalize, 'jira-client exports no normalizeIssue').toBe('function');
  });

  it('every listed criterion under the heading is extracted — and nothing from the next section', () => {
    const n = normalize(issue(DOC));
    expect(n.acceptanceCriteria).toEqual(CRITERIA);
  });

  it('the description keeps the list — its items are in the text the agents read', () => {
    const n = normalize(issue(DOC));
    for (const c of CRITERIA) expect(n.description).toContain(c);
  });

  it('a description with no such heading still yields none', () => {
    const n = normalize(issue({ type: 'doc', version: 1, content: [heading('Notes'), bullets(['an item that is long enough'])] }));
    expect(n.acceptanceCriteria).toEqual([]);
  });
});
