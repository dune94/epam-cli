/**
 * normalizeIssue's effort field, direct coverage.
 *
 * Fixed 2026-08-06 alongside jira-adapter.js's identical bug: this file had its OWN
 * independent copy of pointsToEffort, and testing effort only indirectly through an
 * HTTP-mocked getIssue() call is how that duplication went unnoticed — this now shares
 * jira-adapter.js's implementation, tested directly here rather than only through mocks.
 */
import { describe, it, expect } from 'vitest';

const { normalizeIssue } = require('../../../orchestrations/scripts/lib/jira-client.js');

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    key: 'AMSD-2041',
    fields: {
      summary: 'Live Preview of Content in CMS',
      description: '',
      status: { name: 'To Do' },
      labels: [],
      issuetype: { name: 'Story' },
      ...overrides,
    },
  };
}

describe('normalizeIssue — effort defaults to medium, never a fabricated low', () => {
  it('THE BUG, fixed 2026-08-06: an unestimated ticket (no customfield_10016) gets "medium"', () => {
    // The real AMSD-2041 shape: title-only, blank description, no story-point estimate.
    const result = normalizeIssue(makeIssue());
    expect(result.effort).toBe('medium');
  });

  it('a genuinely 0-point ticket still resolves to "low"', () => {
    const result = normalizeIssue(makeIssue({ customfield_10016: 0 }));
    expect(result.effort).toBe('low');
  });

  it('a real 8-point ticket resolves to "high"', () => {
    const result = normalizeIssue(makeIssue({ customfield_10016: 8 }));
    expect(result.effort).toBe('high');
  });

  it('shares jira-adapter.js\'s implementation structurally — not a second, driftable copy', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../../orchestrations/scripts/lib/jira-client.js'), 'utf8'
    );
    expect(src, 'a second copy of pointsToEffort would drift out of sync with the fix, as it already did once').not.toMatch(/function pointsToEffort/);
    expect(src).toMatch(/require\(['"]\.\/jira-adapter['"]\)/);
  });
});
