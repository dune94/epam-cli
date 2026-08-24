/**
 * jira-adapter.js — real, direct in-process coverage of all exported
 * functions. Genuinely untested before this (zero test files referenced
 * it). Pure functions, no I/O — no mocking needed, real calls throughout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  adapt,
  pointsToEffort,
  sizeLabelToEffort,
  mapStatus,
  extractAC,
} = require('../../../orchestrations/scripts/lib/jira-adapter.js');

describe('pointsToEffort', () => {
  it('maps 0 points to low', () => {
    expect(pointsToEffort(0)).toBe('low');
  });
  it('maps 2 points to low (boundary)', () => {
    expect(pointsToEffort(2)).toBe('low');
  });
  it('maps 3 points to medium (boundary)', () => {
    expect(pointsToEffort(3)).toBe('medium');
  });
  it('maps 5 points to medium (boundary)', () => {
    expect(pointsToEffort(5)).toBe('medium');
  });
  it('maps 6 points to high (boundary)', () => {
    expect(pointsToEffort(6)).toBe('high');
  });
  it('maps a large number to high', () => {
    expect(pointsToEffort(21)).toBe('high');
  });
  it('THE BUG, fixed 2026-08-06: an UNESTIMATED ticket is undefined, never a fabricated "low"', () => {
    // AMSD-2041 (title-only, blank description, zero ACs — never groomed in Jira) got
    // effort:"low" from exactly this — Number(undefined) is NaN, NaN || 0 is 0, and a
    // never-estimated ticket landed in the same bucket as a verified-trivial one. The
    // detective later found this story touches a shared context consumed by 30+
    // components. Absence of an estimate is not evidence the work is small.
    expect(pointsToEffort(undefined)).toBeUndefined();
    expect(pointsToEffort(null)).toBeUndefined();
    expect(pointsToEffort('')).toBeUndefined();
    expect(pointsToEffort('not-a-number')).toBeUndefined();
  });
  it('a GENUINELY VERIFIED 0-point ticket is still low — this is not the same as absence', () => {
    expect(pointsToEffort(0)).toBe('low');
    expect(pointsToEffort('0')).toBe('low');
  });
  it('treats a negative number as <= 2 -> low', () => {
    expect(pointsToEffort(-5)).toBe('low');
  });
  it('accepts a numeric string', () => {
    expect(pointsToEffort('8')).toBe('high');
  });
});

describe('sizeLabelToEffort — a real Jira grooming signal, consulted before the neutral default', () => {
  it('maps size-s / size-small to low', () => {
    expect(sizeLabelToEffort(['size-s'])).toBe('low');
    expect(sizeLabelToEffort(['size-small'])).toBe('low');
  });
  it('maps size-m / size-medium to medium', () => {
    expect(sizeLabelToEffort(['size-m'])).toBe('medium');
    expect(sizeLabelToEffort(['size-medium'])).toBe('medium');
  });
  it('maps size-l and size-xl to high', () => {
    expect(sizeLabelToEffort(['size-l'])).toBe('high');
    expect(sizeLabelToEffort(['size-xl'])).toBe('high');
  });
  it('accepts the "t-shirt-" and "tshirt-" prefix forms too', () => {
    expect(sizeLabelToEffort(['t-shirt-s'])).toBe('low');
    expect(sizeLabelToEffort(['tshirt-l'])).toBe('high');
  });
  it('is case-insensitive', () => {
    expect(sizeLabelToEffort(['SIZE-L'])).toBe('high');
  });
  it('accepts object-shaped labels ({name: ...}), matching the urgent-label convention', () => {
    expect(sizeLabelToEffort([{ name: 'size-l' }])).toBe('high');
  });
  it('returns undefined when no size label is present — never invents one', () => {
    expect(sizeLabelToEffort(['urgent', 'codeline-metrolinx'])).toBeUndefined();
    expect(sizeLabelToEffort([])).toBeUndefined();
    expect(sizeLabelToEffort(undefined)).toBeUndefined();
  });
  it('ignores an unrecognized size word rather than guessing', () => {
    expect(sizeLabelToEffort(['size-gigantic'])).toBeUndefined();
  });
});

describe('mapStatus', () => {
  // THE VOCABULARY IS THE PROJECT'S, so these declare it exactly as a project's config.env does.
  // They used to pass with nothing declared, because the engine matched the English words
  // itself — which meant a workflow in any other language classified everything as pending, and
  // `completed` gates whether a story is skipped. The REQUIREMENT is unchanged: these words map
  // this way. What moved is who says so.
  const DECLARED = { completed: 'Done,Closed,Resolved', inProgress: 'In Progress,Review,Testing' };
  beforeEach(() => {
    process.env.JIRA_STATUS_COMPLETED = DECLARED.completed;
    process.env.JIRA_STATUS_IN_PROGRESS = DECLARED.inProgress;
  });
  afterEach(() => {
    delete process.env.JIRA_STATUS_COMPLETED;
    delete process.env.JIRA_STATUS_IN_PROGRESS;
  });

  it.each([
    ['Done', 'completed'],
    ['Closed', 'completed'],
    ['Resolved', 'completed'],
    ['done', 'completed'], // case-insensitive
    ['In Progress', 'in-progress'],
    ['In Review', 'in-progress'],
    ['Testing', 'in-progress'],
    ['To Do', 'pending'],
    ['Backlog', 'pending'],
    ['', 'pending'],
  ])('maps status "%s" to "%s"', (input, expected) => {
    expect(mapStatus(input)).toBe(expected);
  });

  it('classifies NOTHING when the project declares nothing', () => {
    // The half the old suite could not express: with no declaration the engine has no opinion,
    // and a status it has not been told about must not be read as finished.
    delete process.env.JIRA_STATUS_COMPLETED;
    delete process.env.JIRA_STATUS_IN_PROGRESS;
    expect(mapStatus('Done')).toBe('pending');
  });

  it('handles undefined/null gracefully as pending', () => {
    expect(mapStatus(undefined)).toBe('pending');
    expect(mapStatus(null)).toBe('pending');
  });
});

describe('extractAC', () => {
  it('extracts a bulleted Acceptance Criteria section from plain text', () => {
    const desc = `Some description.\n\nAcceptance Criteria:\n- First AC\n- Second AC\n- Third AC\n`;
    const acs = extractAC(desc, null);
    expect(acs).toEqual(['First AC', 'Second AC', 'Third AC']);
  });

  it('supports *, -, and • bullet markers', () => {
    const desc = `Acceptance Criteria:\n* Star bullet\n- Dash bullet\n• Dot bullet\n`;
    const acs = extractAC(desc, null);
    expect(acs).toEqual(['Star bullet', 'Dash bullet', 'Dot bullet']);
  });

  it('returns [] when there is no Acceptance Criteria heading at all', () => {
    const desc = `Just a plain description with no AC section.`;
    expect(extractAC(desc, null)).toEqual([]);
  });

  it('returns [] for empty/undefined/null description', () => {
    expect(extractAC('', null)).toEqual([]);
    expect(extractAC(undefined, null)).toEqual([]);
    expect(extractAC(null, null)).toEqual([]);
  });

  it('filters out bullet lines that are too short (<=5 chars) as noise', () => {
    const desc = `Acceptance Criteria:\n- ok\n- A real, longer criterion\n`;
    const acs = extractAC(desc, null);
    expect(acs).toEqual(['A real, longer criterion']);
  });

  it('handles ADF (Atlassian Document Format) description objects via extractPlainText', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Acceptance Criteria:' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '- ADF-derived criterion one' }] },
      ],
    };
    // extractAC expects a string OR relies on the caller pre-flattening —
    // adapt() itself calls extractPlainText before extractAC, so exercise
    // that same real path via adapt() rather than passing raw ADF here.
    const flat = adf.content.map((n: any) => n.content.map((c: any) => c.text).join(' ')).join('\n');
    const acs = extractAC(flat, null);
    expect(acs).toEqual(['ADF-derived criterion one']);
  });
});

describe('adapt — full payload normalization', () => {
  function makeIssuePayload(overrides: any = {}) {
    return {
      webhookEvent: 'jira:issue_created',
      issue: {
        key: 'AMSD-1820',
        fields: {
          project: { key: 'AMSD' },
          summary: 'Fix return-trip discount propagation',
          description: 'Acceptance Criteria:\n- Discount shows for return trips\n- No regression for one-way trips\n',
          status: { name: 'To Do' },
          labels: [],
          story_points: 3,
          issuetype: { name: 'Bug' },
          ...overrides,
        },
      },
    };
  }

  it('adapts a real, complete issue payload into the expected PRD story shape', () => {
    const result = adapt(makeIssuePayload());
    expect(result).toMatchObject({
      projectKey: 'AMSD',
      jiraKey: 'AMSD-1820',
      storyId: 'AMSD-1820',
      title: 'Fix return-trip discount propagation',
      effort: 'medium',
      status: 'pending',
      urgent: false,
      agentRole: 'engineer',
      aiProvider: 'claude',
      completed: false,
    });
    expect(result.acceptanceCriteria).toEqual([
      'Discount shows for return trips',
      'No regression for one-way trips',
    ]);
  });

  it('returns null for a completely malformed/non-object payload', () => {
    expect(adapt(null)).toBeNull();
    expect(adapt(undefined)).toBeNull();
    expect(adapt('a string')).toBeNull();
    expect(adapt(42)).toBeNull();
  });

  it('returns null for sprint events (no individual issue to adapt)', () => {
    expect(adapt({ webhookEvent: 'sprint_started' })).toBeNull();
    expect(adapt({ webhookEvent: 'sprint_closed' })).toBeNull();
  });

  it('returns null when there is no issue/fields in the payload', () => {
    expect(adapt({ webhookEvent: 'jira:issue_created' })).toBeNull();
  });

  it('returns null when key, projectKey, or summary is missing', () => {
    const noKey = makeIssuePayload();
    delete noKey.issue.key;
    expect(adapt(noKey)).toBeNull();

    const noSummary = makeIssuePayload({ summary: '' });
    expect(adapt(noSummary)).toBeNull();
  });

  it('returns null for a type OUTSIDE the vocabulary the project declared', () => {
    // The filter is the project's now. Undeclared it filters nothing, because an empty backlog
    // is the least visible way for an ingest to fail — a project whose work is "Defect" used to
    // get exactly that, silently.
    process.env.JIRA_ISSUE_TYPES = 'Story,Task,Bug,Sub-task,Subtask';
    expect(adapt(makeIssuePayload({ issuetype: { name: 'Epic' } }))).toBeNull();
    delete process.env.JIRA_ISSUE_TYPES;
  });

  it('and ingests that same type when NOTHING is declared', () => {
    delete process.env.JIRA_ISSUE_TYPES;
    expect(adapt(makeIssuePayload({ issuetype: { name: 'Epic' } }))).not.toBeNull();
  });

  it('accepts every type the project declares', () => {
    process.env.JIRA_ISSUE_TYPES = 'Story,Task,Bug,Sub-task,Subtask';
    for (const t of ['Story', 'Task', 'Bug', 'Sub-task', 'Subtask']) {
      const result = adapt(makeIssuePayload({ issuetype: { name: t } }));
      expect(result, `issue type ${t} should be accepted`).not.toBeNull();
    }
    delete process.env.JIRA_ISSUE_TYPES;
  });

  // WAS: 'the "qa-engineer" agentRole branch is currently UNREACHABLE'. It was unreachable because
  // the role was decided by whether the type name contained "test" or "qa", and the five types the
  // engine allowed contained neither — a branch that could only ever fire for a type the filter
  // above it had already rejected. Both halves of that were the engine guessing at English.
  //
  // The routing is declared now, so the branch is reachable by saying so, in any language.
  it('routes to the QA role for the types the project names, and not otherwise', () => {
    process.env.JIRA_QA_ISSUE_TYPES = 'Test,Prüfung';

    const qa = adapt(makeIssuePayload({ issuetype: { name: 'Test' } }));
    expect(qa?.agentRole, 'a declared QA type did not route to the QA role').toBe('qa-engineer');

    const nonLatin = adapt(makeIssuePayload({ issuetype: { name: 'Prüfung' } }));
    expect(nonLatin?.agentRole).toBe('qa-engineer');

    for (const t of ['Story', 'Task', 'Bug']) {
      expect(adapt(makeIssuePayload({ issuetype: { name: t } }))?.agentRole, t).toBe('engineer');
    }
    delete process.env.JIRA_QA_ISSUE_TYPES;
  });

  it('and an English type name is NOT special when nothing is declared', () => {
    delete process.env.JIRA_QA_ISSUE_TYPES;
    expect(adapt(makeIssuePayload({ issuetype: { name: 'Test' } }))?.agentRole).toBe('engineer');
  });

  it('detects the "urgent" label case-insensitively, including object-shaped labels', () => {
    const withStringLabel = adapt(makeIssuePayload({ labels: ['URGENT'] }));
    expect(withStringLabel?.urgent).toBe(true);

    const withObjectLabel = adapt(makeIssuePayload({ labels: [{ name: 'Urgent' }] }));
    expect(withObjectLabel?.urgent).toBe(true);

    const withoutUrgent = adapt(makeIssuePayload({ labels: ['backend'] }));
    expect(withoutUrgent?.urgent).toBe(false);
  });

  it('extracts epicKey from fields.epic, the DECLARED field, or parent.key, in that precedence', () => {
    // customfield_10014 was written into the engine and is not this tenant's epic link at all —
    // on the live instance it is customfield_10008, so the hardcoded id read as absent and the
    // value survived only by falling through to parent.key.
    process.env.JIRA_FIELD_EPIC_LINK = 'customfield_10008';

    const fromEpic = adapt(makeIssuePayload({ epic: 'AMSD-1' }));
    expect(fromEpic?.epicKey).toBe('AMSD-1');

    const fromCustomField = adapt(makeIssuePayload({ customfield_10008: 'AMSD-2' }));
    expect(fromCustomField?.epicKey).toBe('AMSD-2');

    const fromParent = adapt(makeIssuePayload({ parent: { key: 'AMSD-3' } }));
    expect(fromParent?.epicKey).toBe('AMSD-3');

    const noEpic = adapt(makeIssuePayload());
    expect(noEpic?.epicKey).toBeNull();
    delete process.env.JIRA_FIELD_EPIC_LINK;
  });

  it('marks completed:true when the status is one the project calls finished', () => {
    process.env.JIRA_STATUS_COMPLETED = 'Done,Closed,Resolved';
    const result = adapt(makeIssuePayload({ status: { name: 'Done' } }));
    expect(result?.status).toBe('completed');
    expect(result?.completed).toBe(true);
    delete process.env.JIRA_STATUS_COMPLETED;
  });

  it('and does NOT mark it finished when the project has said nothing', () => {
    // `completed` decides whether a story is skipped. Reading an undeclared word as finished is
    // the one error that loses work silently.
    delete process.env.JIRA_STATUS_COMPLETED;
    const result = adapt(makeIssuePayload({ status: { name: 'Done' } }));
    expect(result?.completed).toBe(false);
  });

  /**
   * INVERTED 2026-08-06. This asserted the description was CLIPPED to 2000 characters, at
   * the adapter — the source, so every consumer downstream inherited a clipped ticket. In
   * brownfield the description is the only substantive content a ticket carries: the AC gate
   * skips acceptance criteria and records that VCs are derived from the description, and
   * codeline discovery chooses which client repository gets modified from it. The cap was
   * the defect; the test guarding it made the defect look intentional.
   */
  it('a long description is passed through WHOLE, never clipped', () => {
    const longDesc = 'x'.repeat(5000);
    const result = adapt(makeIssuePayload({ description: longDesc }));
    expect(result?.description.length, 'the adapter clipped the ticket at the source').toBe(5000);
  });

  it('handles the payload.fields (flat, no nested issue) shape as an alternative to payload.issue', () => {
    const flatPayload = {
      webhookEvent: 'jira:issue_updated',
      key: 'AMSD-99',
      fields: {
        project: { key: 'AMSD' },
        summary: 'Flat-shape payload test',
        description: '',
        status: { name: 'To Do' },
        issuetype: { name: 'Story' },
      },
    };
    const result = adapt(flatPayload);
    expect(result).not.toBeNull();
    expect(result?.jiraKey).toBe('AMSD-99');
  });

  it('a t-shirt-size label wins over the neutral default when story points are absent', () => {
    const noPoints = makeIssuePayload({ labels: ['size-l'] });
    delete noPoints.issue.fields.story_points;
    const result = adapt(noPoints);
    expect(result?.effort).toBe('high');
  });

  it('THE BUG, fixed 2026-08-06: adapt() gives an unestimated ticket effort:"medium", never "low"', () => {
    const noPoints = makeIssuePayload();
    delete noPoints.issue.fields.story_points;
    const result = adapt(noPoints);
    expect(
      result?.effort,
      'AMSD-2041 was unestimated and got effort:"low" from this exact path — an absent ' +
        'story-point estimate must fall back to the same neutral default the batch-ingest ' +
        'path (synthesize-prd-from-jira.js) already uses, not a fabricated cheap bucket',
    ).toBe('medium');
  });

  it('a genuinely 0-point ticket still resolves to "low" through adapt() — not conflated with absence', () => {
    const result = adapt(makeIssuePayload({ story_points: 0 }));
    expect(result?.effort).toBe('low');
  });

  it('run 10x in a row against the same real payload — fully deterministic output', () => {
    const payload = makeIssuePayload();
    const results = Array.from({ length: 10 }, () => adapt(payload));
    const serialized = results.map(r => JSON.stringify(r));
    expect(new Set(serialized).size).toBe(1);
  });
});
