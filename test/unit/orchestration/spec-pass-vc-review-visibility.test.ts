/**
 * Live gap, found 2026-07-31 while investigating why a mock1 run's spec-pass
 * cycled through openspec + code-graph-detective + the full VC enforcement
 * loop repeatedly and eventually blew the test's 45-minute timeout.
 *
 * Root cause: captureStorySnapshot() — the ONLY thing the prd-change-reviewer
 * is shown as the before/after diff for a spec_pass change — never included
 * verificationCriteria. The reviewer's own rule set explicitly says to reject
 * when "verificationCriteria is empty while the description names concrete
 * testable behaviour", but since the field was never in the snapshot, it read
 * as permanently absent regardless of the story's real state — a false
 * rejection that fired on essentially any brownfield story with a concrete
 * description, forcing the reviewer's 3-attempt retry loop (each attempt
 * re-runs the full spec agent + detective + VC loop) for a change that never
 * actually happened.
 *
 * story.verificationCriteria is set by enforceVerificationCriteria (called
 * from inside runSpecAgent) BEFORE afterSnapshot is captured in the caller,
 * so the real value is available at snapshot time — it just was never read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
  'utf8',
);

// Load the real function via the module's exports rather than re-implementing
// its logic — this is a pure function, safe to require directly.
const specModeRunner = require(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
);

describe('captureStorySnapshot() — includes verificationCriteria (reviewer visibility fix)', () => {
  it('exports captureStorySnapshot', () => {
    expect(typeof specModeRunner.captureStorySnapshot).toBe('function');
  });

  it('includes the real verificationCriteria array when the story has one', () => {
    const story = {
      acceptanceCriteria: [],
      description: 'Hello world greeting should say hello dolly',
      title: 'Hello world greeting should say hello dolly',
      technicalNotes: null,
      verificationCriteria: [
        "Calling getGreeting() returns 'hello dolly'.",
        'Existing behavior related to this area is unchanged.',
      ],
    };
    const snapshot = specModeRunner.captureStorySnapshot(story);
    expect(snapshot.verificationCriteria).toEqual(story.verificationCriteria);
  });

  it('defaults to an empty array when the story has no verificationCriteria (never undefined — reviewer prompt must see a concrete value)', () => {
    const story = { acceptanceCriteria: [], description: 'x', title: 'y', technicalNotes: null };
    const snapshot = specModeRunner.captureStorySnapshot(story);
    expect(snapshot.verificationCriteria).toEqual([]);
  });

  it('returns a fresh copy, not a live reference to story.verificationCriteria (mutation isolation, matching acceptanceCriteria\'s existing pattern)', () => {
    const vc = ['original VC'];
    const story = { acceptanceCriteria: [], description: 'x', title: 'y', technicalNotes: null, verificationCriteria: vc };
    const snapshot = specModeRunner.captureStorySnapshot(story);
    vc.push('mutated after snapshot');
    expect(snapshot.verificationCriteria).toEqual(['original VC']);
  });

  it('the reviewer-facing snapshot payload (capReviewSnapshot spreads captureStorySnapshot) therefore carries verificationCriteria through to the prompt', () => {
    // capReviewSnapshot only overrides acceptanceCriteria (for length capping)
    // and spreads everything else — confirm it does not strip the new field.
    const idx = SRC.indexOf('function capReviewSnapshot(snapshot) {');
    expect(idx).toBeGreaterThan(-1);
    const body = SRC.slice(idx, SRC.indexOf('\n}', idx) + 2);
    expect(body).toMatch(/\.\.\.snapshot/);
    expect(body).not.toMatch(/verificationCriteria:\s*\[\]/); // must not blank it out
  });
});
