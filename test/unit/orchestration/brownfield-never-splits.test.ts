/**
 * A brownfield story is a ticket. It is not ours to subdivide.
 *
 * Live AMSD-2041 2026-07-30. The upexpress lane ran a story called
 * `AMSD-2041-A` — a child that exists nowhere in the client's Jira — which
 * reached implementation and wrote nothing:
 *
 *   Story AMSD-2041-A: all 2 declared deliverable(s) exist but are UNCHANGED
 *   since baseline — no real work done anywhere in the declared set
 *
 * How it came to exist: AMSD-2041's Jira ticket carries NO acceptance criteria.
 * speckit invented 15 from the title (happy path, platform variants, edge
 * cases, error handling, security, accessibility, viewport). storyRequiresSplit
 * saw 15 > SPLIT_MANDATE_AC_THRESHOLD (12), declared a mandate, and
 * checkSplitMandateViolation forced openspec to retry with:
 *
 *   "You MUST output a non-empty splitStories array in your response this time."
 *
 * So the pipeline split a real client ticket on the strength of criteria it had
 * made up about itself.
 *
 * Three greenfield assumptions are stacked in that rule, none of which hold on
 * a brownfield codebase:
 *   1. ACs are authored by someone who knows the work — here they were invented
 *      from a one-line title, so AC count measures the inventor, not the story.
 *   2. AC count proxies story size — for a minimal fix to existing code it does
 *      not; the fix can be three lines behind fifteen observable behaviours.
 *   3. A story is ours to subdivide — in brownfield the story IS the ticket.
 *      `AMSD-2041-A` can never be written back (writes to client systems are
 *      hard-blocked), so a child is a fiction the run cannot reconcile.
 *
 * Multi-codeline work is explicitly NOT a split: one story, N executions,
 * joined state. Splitting fragments a minimal fix across children that each
 * then fail their own deliverable check, which is exactly what happened.
 *
 * THE RULE: greenfield rules do not seep into brownfield. The mandate stays
 * exactly as it is for greenfield — this is a guard, not a redesign.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
const { storyRequiresSplit, checkSplitMandateViolation } = runner;

const ORIGINAL = process.env.EPAM_BROWNFIELD;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EPAM_BROWNFIELD;
  else process.env.EPAM_BROWNFIELD = ORIGINAL;
});

/** The live story: 15 invented ACs over a ticket that shipped with none. */
const FIFTEEN_ACS = {
  id: 'AMSD-2041',
  acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `AC-${i + 1}: some observable behaviour`),
  technicalNotes: { files: ['src/context/ContentstackContext.tsx'] },
};

/** The other trigger: impl and test files declared on one story. */
const MIXED_FILES = {
  id: 'AMSD-2041',
  acceptanceCriteria: ['AC-1: one criterion'],
  technicalNotes: { files: ['src/services/contentstack.ts', 'src/services/contentstack.test.ts'] },
};

describe('brownfield stories are never mandated to split', () => {
  it('15 invented ACs do not force a split — the live case', () => {
    process.env.EPAM_BROWNFIELD = '1';
    const { required, reason } = storyRequiresSplit(FIFTEEN_ACS);
    expect(required,
      `a real Jira ticket was split into AMSD-2041-A because the pipeline invented ` +
      `15 ACs and then measured itself against them (${reason})`)
      .toBe(false);
  });

  it('mixed impl and test files do not force a split', () => {
    process.env.EPAM_BROWNFIELD = '1';
    expect(storyRequiresSplit(MIXED_FILES).required).toBe(false);
  });

  it('the mandate check reports no violation for an unsplit brownfield story', () => {
    // checkSplitMandateViolation is what actually forces the openspec retry.
    // Guarding storyRequiresSplit alone would be pointless if this still fired.
    process.env.EPAM_BROWNFIELD = '1';
    const { violated } = checkSplitMandateViolation(FIFTEEN_ACS, 0);
    expect(violated, 'openspec is still being forced to invent a split child').toBe(false);
  });
});

describe('greenfield behaviour is untouched', () => {
  // This is a guard, not a redesign. Every greenfield project depends on the
  // mandate: a 15-AC story with combined impl+test files exhausted its whole
  // escalation ladder unsplit (2026-07-06), which is why the rule exists.
  it('still mandates a split above the AC threshold', () => {
    process.env.EPAM_BROWNFIELD = '0';
    const { required, reason } = storyRequiresSplit(FIFTEEN_ACS);
    expect(required, 'the greenfield AC-count mandate was disabled').toBe(true);
    expect(reason).toMatch(/15 acceptance criteria/);
  });

  it('still mandates a split for combined impl and test files', () => {
    process.env.EPAM_BROWNFIELD = '0';
    expect(storyRequiresSplit(MIXED_FILES).required,
      'the greenfield impl+test mandate was disabled').toBe(true);
  });

  it('still reports a mandate violation when greenfield does not split', () => {
    process.env.EPAM_BROWNFIELD = '0';
    expect(checkSplitMandateViolation(FIFTEEN_ACS, 0).violated).toBe(true);
  });

  it('unset EPAM_BROWNFIELD behaves as greenfield', () => {
    // The guard must key on brownfield being ON, not on it being absent —
    // otherwise every project without the variable silently loses the mandate.
    delete process.env.EPAM_BROWNFIELD;
    expect(storyRequiresSplit(FIFTEEN_ACS).required).toBe(true);
  });
});

describe('a volunteered split is dropped too', () => {
  // Guarding the MANDATE only stops the pipeline DEMANDING a child. An agent
  // can still offer one unasked, and the outcome is identical: a story id that
  // exists in no tracker, fragmenting a minimal fix. Prompt instruction alone
  // has already proven insufficient for exactly this on the speckit path.
  const SRC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('drops splitStories from any agent when brownfield', () => {
    const i = SRC.indexOf('EPAM_BROWNFIELD === \'1\' && Array.isArray(payload.splitStories)');
    expect(i, 'no deterministic brownfield drop for volunteered splitStories — an ' +
      'agent can still create a child the mandate guard would have refused')
      .toBeGreaterThan(-1);
    // It must actually delete them, not merely log.
    expect(SRC.slice(i, i + 500)).toMatch(/delete payload\.splitStories/);
  });

  it('the drop is not scoped to a single agent', () => {
    // The pre-existing rule above it is `agent === 'speckit'`. The brownfield
    // rule must apply to openspec too — openspec is the one the mandate used
    // to force, so scoping this to speckit would leave the live path open.
    const i = SRC.indexOf('EPAM_BROWNFIELD === \'1\' && Array.isArray(payload.splitStories)');
    const line = SRC.slice(SRC.lastIndexOf('\n', i) + 1, i);
    expect(line, 'the brownfield split drop is limited to one agent').not.toMatch(/agent === '/);
  });
});

describe('a small brownfield story is unaffected either way', () => {
  it('does not require a split regardless of mode', () => {
    const small = { id: 'X-1', acceptanceCriteria: ['AC-1'], technicalNotes: { files: ['src/a.ts'] } };
    for (const mode of ['1', '0']) {
      process.env.EPAM_BROWNFIELD = mode;
      expect(storyRequiresSplit(small).required).toBe(false);
    }
  });
});
