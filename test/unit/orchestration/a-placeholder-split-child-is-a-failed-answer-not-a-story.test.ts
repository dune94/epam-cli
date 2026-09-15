/**
 * A PLACEHOLDER SPLIT CHILD IS A FAILED ANSWER, NOT A STORY.
 *
 * The spec prompt shows the model an example child (`"id":"optional","title":"..."`). On the
 * regintel greenfield run of 2026-09-15 the model echoed it back; the split accepted it as a real
 * child, deprecated REGI-001 for it, CPA downgraded its own "fields are placeholders" finding, and
 * the run died at a phase gate after $9. Every model call has retry, ladder and self-heal at the
 * hub (llm-handler.sh, 2026-07-28) — but only for an answer something declares failed. This
 * declares it: a payload whose split children are the schema's placeholders is a failed answer,
 * classed `placeholder-split`, retried WITH a correction like the other four classes; and if the
 * retries are exhausted the placeholders are dropped and the parent kept whole — never an abort.
 *
 * GREENFIELD is the mode that splits (brownfield never does: stories are tickets).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
process.env.SPEC_MODE_NO_MAIN = '1';
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));

// The example the prompt shows, read from where it is declared — never spelled here.
const placeholderChild = JSON.parse(JSON.stringify(spec.SPLIT_CHILD_EXAMPLE));
const realChild = { id: 'REGI-001-A', title: 'Ingest the feed', description: 'Pull the regulatory feed on a schedule', acceptanceCriteria: ['feed rows land in the store'], agentRole: 'regintel-pipeline-engineer', technicalNotes: { files: ['src/ingest.py'] } };

describe('a placeholder split child is a failed answer, not a story', () => {
  it('the runner exports the judgement and the remedy, and renders its schema hint from the declared example', () => {
    expect(spec.SPLIT_CHILD_EXAMPLE).toEqual(require(join(ROOT, 'orchestrations/config/spec-split-example.json')).child);
    expect(typeof spec.specPayloadFailure).toBe('function');
    expect(typeof spec.dropPlaceholderSplits).toBe('function');
  });
  it('a payload whose split children are the schema placeholders is classed placeholder-split', () => {
    expect(spec.specPayloadFailure({ storyId: 'REGI-001', splitStories: [placeholderChild] })).toBe('placeholder-split');
    expect(spec.specPayloadFailure({ storyId: 'REGI-001', splitStories: [realChild, placeholderChild] })).toBe('placeholder-split');
  });
  it('a real split, or no split, is not a failure', () => {
    expect(spec.specPayloadFailure({ storyId: 'REGI-001', splitStories: [realChild] })).toBeNull();
    expect(spec.specPayloadFailure({ storyId: 'REGI-001', splitStories: [] })).toBeNull();
    expect(spec.specPayloadFailure({ storyId: 'REGI-001' })).toBeNull();
  });
  it('the class carries a corrective note for the retry, like the other four', () => {
    const note = spec.specCorrectiveNote('placeholder-split');
    expect(note).toMatch(/REJECTED/);
    expect(note).toMatch(new RegExp(placeholderChild.id));
  });
  it('when retries are exhausted the placeholders are dropped and the parent is kept whole — no abort', () => {
    const p = { storyId: 'REGI-001', splitStories: [realChild, placeholderChild] };
    const out = spec.dropPlaceholderSplits(p);
    expect(out.splitStories).toEqual([realChild]);
    const only = spec.dropPlaceholderSplits({ storyId: 'REGI-001', splitStories: [placeholderChild] });
    expect(only.splitStories).toEqual([]);
  });
  it('the retry loop tests the payload, not only its presence (source executes the judgement)', () => {
    // The predicate the loop retries on must consult specPayloadFailure; a payload with a
    // placeholder child must be retried. Executed through the exported predicate.
    expect(typeof spec.specNeedsRetry).toBe('function');
    expect(spec.specNeedsRetry({ payload: { storyId: 'REGI-001', splitStories: [placeholderChild] } })).toBe(true);
    expect(spec.specNeedsRetry({ payload: { storyId: 'REGI-001', splitStories: [realChild] } })).toBe(false);
    expect(spec.specNeedsRetry(null)).toBe(true);
    expect(spec.specNeedsRetry({ payload: null })).toBe(true);
  });
});
