/**
 * THE TRACKER'S SCHEMA BELONGS TO THE PROJECT, NOT TO THE ENGINE.
 *
 * The ingest carried one Jira tenant's private configuration as engine code:
 *
 *   customfield_10016 / customfield_10014   another tenant's field ids for points and epic link
 *   issuetype in (Story, Task, Bug)         an English type whitelist in the default query
 *   supportedTypes = [story, task, bug, …]  and a second one that SILENTLY DROPS every ticket
 *                                           whose type is not in it — return null, no message
 *   issuetype.name || 'Story'               an unknown type becomes a Story
 *   status.name || 'To Do'                  a missing status becomes one that exists nowhere
 *   'test'/'qa' substring → qa-engineer     English substring matching deciding which role
 *                                           handles the work
 *
 * Custom field ids differ per Jira instance, so points and epic link read as absent on any other
 * tenant. Type and status names differ per workflow — this project's own board carries
 * "READY FOR DEV", "IN ANALYSIS" and "BA ACCEPTANCE", none of which any of the lists above knows.
 *
 * The worst of them is the silent one: a project whose tickets are "Defect" or "Change Request"
 * ingests NOTHING, and the run reports no stories rather than an unreadable schema.
 *
 * What replaces it: the project declares its own field ids and type vocabulary, and absence stays
 * absence — an undeclared vocabulary filters nothing rather than filtering everything.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';

const ADAPTER = join(__dirname, '../../../orchestrations/scripts/lib/jira-adapter.js');

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

/** A Jira issue as the REST API returns it, with the fields under test. */
const issue = (fields: Record<string, unknown>) => ({
  key: 'ABC-1',
  fields: {
    project: { key: 'ABC' },
    summary: 'a summary',
    description: 'a description',
    issuetype: { name: 'Story' },
    status: { name: 'To Do' },
    labels: [],
    ...fields,
  },
});

const adapt = (payload: unknown) => {
  delete require.cache[require.resolve(ADAPTER)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  return require(ADAPTER).adapt(payload);
};

describe('the field ids come from the project', () => {
  it('reads story points from the field the project declares', () => {
    process.env.JIRA_FIELD_STORY_POINTS = 'customfield_99999';
    const out = adapt(issue({ customfield_99999: 8 }));
    expect(out, 'the ticket was dropped entirely').toBeTruthy();
    // 8 points is not "medium" — if the field were unread it would fall through to the default.
    expect(out.effort).toBeTruthy();
    expect(out.effort).not.toBe('medium');
  });

  it('reads the epic link from the field the project declares', () => {
    process.env.JIRA_FIELD_EPIC_LINK = 'customfield_88888';
    const out = adapt(issue({ customfield_88888: 'EPIC-7' }));
    expect(out.epicKey).toBe('EPIC-7');
  });

  it('names no tenant field id of its own', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const src = require('node:fs').readFileSync(ADAPTER, 'utf8').split('\n')
      .filter((l: string) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(src).not.toMatch(/customfield_\d+/);
  });
});

describe('an undeclared vocabulary filters nothing', () => {
  it('ingests a type no English list knows, when the project declares none', () => {
    delete process.env.JIRA_ISSUE_TYPES;
    const out = adapt(issue({ issuetype: { name: 'Änderungsantrag' } }));
    expect(out, 'a ticket was silently dropped for having an unfamiliar type').toBeTruthy();
    expect(out.jiraKey).toBe('ABC-1');
  });

  it('honours the vocabulary when the project declares one', () => {
    process.env.JIRA_ISSUE_TYPES = 'Defect,Change Request';
    expect(adapt(issue({ issuetype: { name: 'Defect' } })), 'a declared type was dropped').toBeTruthy();
    expect(adapt(issue({ issuetype: { name: 'Story' } })), 'an undeclared type was ingested').toBeNull();
  });
});

describe('absence is not filled in', () => {
  it('a ticket with no status is pending, and is not treated as finished', () => {
    // The emitted field is a normalised lifecycle, so it always has a value. What must not happen
    // is a ticket acquiring EVIDENCE it does not have: `completed` gates whether a story is
    // skipped, and pending is the safe direction — attempted again rather than silently dropped.
    const out = adapt(issue({ status: undefined }));
    expect(out).toBeTruthy();
    expect(out.status).toBe('pending');
    expect(out.completed, 'a ticket with no status was reported finished').toBe(false);
  });

  it('classifies by the workflow the project declares, in any language', () => {
    process.env.JIRA_STATUS_COMPLETED = 'BA ACCEPTANCE,Erledigt';
    expect(adapt(issue({ status: { name: 'Erledigt' } })).status).toBe('completed');
    expect(adapt(issue({ status: { name: 'BA ACCEPTANCE' } })).completed).toBe(true);
  });

  it('and classifies nothing when the project declares nothing', () => {
    // English substrings used to decide this — 'done', 'closed', 'resolved'. A workflow that does
    // not speak English had every status read as pending, silently.
    delete process.env.JIRA_STATUS_COMPLETED;
    delete process.env.JIRA_STATUS_IN_PROGRESS;
    expect(adapt(issue({ status: { name: 'Done' } })).completed,
      'an undeclared English word still classified the ticket').toBe(false);
  });

  it('a ticket with no type does not become a Story', () => {
    const out = adapt(issue({ issuetype: undefined }));
    expect(out).toBeTruthy();
    expect(out.type, 'a type was invented').toBeFalsy();
  });
});

describe('which role handles a ticket is declared, not matched on English', () => {
  it('routes to the QA role only for types the project names', () => {
    process.env.JIRA_QA_ISSUE_TYPES = 'Prüfung';
    const qa = adapt(issue({ issuetype: { name: 'Prüfung' } }));
    expect(qa.agentRole).toBe('qa-engineer');
  });

  it('and a type containing "test" is NOT special without a declaration', () => {
    delete process.env.JIRA_QA_ISSUE_TYPES;
    const out = adapt(issue({ issuetype: { name: 'Test Case' } }));
    expect(out.agentRole, 'an English substring decided the role').not.toBe('qa-engineer');
  });
});
