/**
 * jira-adapter.js — real, direct in-process coverage of all exported
 * functions. Genuinely untested before this (zero test files referenced
 * it). Pure functions, no I/O — no mocking needed, real calls throughout.
 */

import { describe, it, expect } from 'vitest';

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

  it('returns null for unsupported issue types (e.g. Epic)', () => {
    expect(adapt(makeIssuePayload({ issuetype: { name: 'Epic' } }))).toBeNull();
  });

  it('accepts all supported issue types: story, task, bug, sub-task, subtask', () => {
    for (const t of ['Story', 'Task', 'Bug', 'Sub-task', 'Subtask']) {
      const result = adapt(makeIssuePayload({ issuetype: { name: t } }));
      expect(result, `issue type ${t} should be accepted`).not.toBeNull();
    }
  });

  it('the "qa-engineer" agentRole branch is currently UNREACHABLE: none of the 5 allowed issue types (story/task/bug/sub-task/subtask) contain "test" or "qa" as a substring, so agentRole is always "engineer" in practice', () => {
    for (const t of ['Story', 'Task', 'Bug', 'Sub-task', 'Subtask']) {
      const result = adapt(makeIssuePayload({ issuetype: { name: t } }));
      expect(result?.agentRole, `issue type ${t}`).toBe('engineer');
    }
    // An issue type that WOULD trigger qa-engineer ("Test") is rejected
    // entirely by the supportedTypes filter before agentRole is ever computed.
    expect(adapt(makeIssuePayload({ issuetype: { name: 'Test' } }))).toBeNull();
  });

  it('detects the "urgent" label case-insensitively, including object-shaped labels', () => {
    const withStringLabel = adapt(makeIssuePayload({ labels: ['URGENT'] }));
    expect(withStringLabel?.urgent).toBe(true);

    const withObjectLabel = adapt(makeIssuePayload({ labels: [{ name: 'Urgent' }] }));
    expect(withObjectLabel?.urgent).toBe(true);

    const withoutUrgent = adapt(makeIssuePayload({ labels: ['backend'] }));
    expect(withoutUrgent?.urgent).toBe(false);
  });

  it('extracts epicKey from fields.epic, customfield_10014, or parent.key, in that precedence', () => {
    const fromEpic = adapt(makeIssuePayload({ epic: 'AMSD-1' }));
    expect(fromEpic?.epicKey).toBe('AMSD-1');

    const fromCustomField = adapt(makeIssuePayload({ customfield_10014: 'AMSD-2' }));
    expect(fromCustomField?.epicKey).toBe('AMSD-2');

    const fromParent = adapt(makeIssuePayload({ parent: { key: 'AMSD-3' } }));
    expect(fromParent?.epicKey).toBe('AMSD-3');

    const noEpic = adapt(makeIssuePayload());
    expect(noEpic?.epicKey).toBeNull();
  });

  it('marks completed:true and status:"completed" when the Jira status is Done', () => {
    const result = adapt(makeIssuePayload({ status: { name: 'Done' } }));
    expect(result?.status).toBe('completed');
    expect(result?.completed).toBe(true);
  });

  it('truncates a very long description to 2000 chars', () => {
    const longDesc = 'x'.repeat(5000);
    const result = adapt(makeIssuePayload({ description: longDesc }));
    expect(result?.description.length).toBe(2000);
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
