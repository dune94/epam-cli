/**
 * HARD REQUIREMENT: discovery must be able to return multiple codelines.
 *
 * Live AMSD-2041, 2026-07-27. The ticket "[GO, UP, MX] Live Preview of Content
 * in CMS" carries four Jira components — GO, UP, MX and Intake & Planning — and
 * the work spans three actively-developed brand sites. Discovery returned ONE
 * repository, and its own justification shows it knew better:
 *
 *   "The ticket is tagged [GO, UP, MX] and concerns CMS live-preview for content
 *    authors, with UPExpress.com being the top-ranked candidate and the UP tag
 *    directly mapping to the UP Express site."
 *
 * It read all three tags, then converged on one. Two causes, both in the
 * pipeline rather than the model:
 *
 *  1. It is missing the evidence. jira-client.js requests summary, description,
 *     status, labels and issuetype — NOT components. The one structured field
 *     that states which product areas a ticket touches never reaches the agent,
 *     which is left inferring product scope from prose.
 *
 *  2. It is told to converge. The rules say "match each ticket to the repository
 *     whose name best fits" (singular) and "if all tickets clearly belong to one
 *     repo, return exactly one entry". Nothing tells it a SINGLE ticket may span
 *     several repositories. It did what it was asked.
 *
 * No mapping, no hardcoding: no brand name, repository name or count appears in
 * engine code. The candidates are still discovered by scanning the codeline root
 * and scored against the ticket's own terms; this only makes returning several
 * of them expressible, and requires each to be justified separately so a wrong
 * pick is visible rather than buried.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const DISCOVERY = readFileSync(join(ROOT, 'orchestrations/scripts/lib/codeline-discovery.js'), 'utf8');
const JIRA = readFileSync(join(ROOT, 'orchestrations/scripts/lib/jira-client.js'), 'utf8');

/** The prompt the discovery agent actually receives. */
function prompt(): string {
  const i = DISCOVERY.indexOf('function buildDiscoveryPrompt');
  const j = DISCOVERY.indexOf('\nfunction ', i + 1);
  return DISCOVERY.slice(i, j > i ? j : DISCOVERY.length);
}

describe('the evidence reaches the agent', () => {
  it('Jira components are fetched', () => {
    // The one structured field stating which product areas a ticket touches.
    expect(JIRA,
      'components are never requested from Jira, so the agent infers product ' +
      'scope from prose and converges on one repository')
      .toMatch(/components/);
  });

  it('components are shown to the discovery agent', () => {
    expect(prompt(), 'components are fetched but never reach the prompt')
      .toMatch(/component/i);
  });
});

describe('returning several codelines is expressible', () => {
  it('does not instruct the agent to pick a single repository', () => {
    const p = prompt();
    // "select your single best guess" / "return exactly one entry" told it to
    // converge on a ticket that genuinely spanned three repositories.
    const convergent = /return exactly one entry/i.test(p) && !/spans?|several|multiple/i.test(p);
    expect(convergent,
      'the rules still push toward one repository per ticket with no counter-case')
      .toBe(false);
  });

  it('states that ONE ticket may span several repositories', () => {
    expect(prompt(),
      'nothing tells the agent a single ticket can belong to more than one repo — ' +
      'the AMSD-2041 failure, where it read three tags and returned one')
      .toMatch(/one ticket.*(several|multiple)|spans?\s+(several|multiple)|more than one repositor/i);
  });

  it('requires a separate reason per selected codeline', () => {
    // A wrong third pick must be visible in the report, not buried behind a
    // single justification covering all of them.
    // `s` flag: the instruction spans lines, and without it a correct
    // implementation reads as a failure.
    expect(prompt(), 'one reason covers every selection, so a bad pick is unattributable')
      .toMatch(/(each|every)[\s\S]{0,80}reason|reason[\s\S]{0,80}(each|every)/i);
  });

  it('does not name any brand, repository or count in engine code', () => {
    // The hard rule: the engine learns nothing client-specific. Candidates come
    // from scanning the codeline root at runtime.
    expect(DISCOVERY).not.toMatch(/gotransit|upexpress|metrolinx|contentstack/i);
    expect(prompt(), 'a fixed number of codelines is baked into the instruction')
      .not.toMatch(/return (two|three|exactly \d+) repositor/i);
  });
});
