/**
 * A VERDICT WHOSE OPENING BRACE WENT INTO THE THINKING BLOCK IS STILL A VERDICT.
 *
 * regintel 140717Z (2026-09-21/22), four times across two runs: a MiniMax-M3 review reached the
 * engine as `dict":"approved","issues":[...]` and was recorded "review output had no parseable
 * verdict — the change was NOT reviewed". Two days were spent guessing at truncation. The raw SSE
 * capture (added 2026-09-21, logs/stream-captures/) settles it: the model closes its reasoning
 * block AFTER it has begun the answer —
 *
 *     …lazy import for clarity.\n\nFinal verdict: **approved**…{"</think>\n\nverdict":"approved",…
 *
 * so stripThinkingBlocks removes `<think>…</think>` correctly and the `{"` inside it goes with it.
 * Nothing is lost on the wire; the answer is intact either side of a tag the model misplaced.
 *
 * The extractor repairs exactly that shape — a JSON object whose leading `{"` was eaten — and only
 * that: text with no object in it still refuses, because auto-approving what was never reviewed is
 * the failure this refusal exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const EXTRACT = join(__dirname, '../../../orchestrations/scripts/lib/handlers/team-lead-review-json.py');
const run = (input: string) => JSON.parse(spawnSync('python3', [EXTRACT], { input, encoding: 'utf8' }).stdout || '{}');

describe('a verdict that lost its brace to the thinking block', () => {
  it('the live shape is read as the approval it is', () => {
    const r = run('dict":"approved","issues":[],"summary":"tests/test_portal.py is present"}');
    expect(r.verdict, 'the reviewer approved and the engine recorded "unparseable"').toBe('approved');
    expect(r.reviewIncomplete ?? false).toBe(false);
  });

  it('a rejection in the same shape keeps its issues', () => {
    const r = run('dict":"changes_requested","issues":[{"severity":"blocker","description":"AC3 fails"}],"summary":"x"}');
    expect(r.verdict).toBe('changes_requested');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].severity).toBe('blocker');
  });

  it('an ordinary verdict is untouched', () => {
    const r = run('here is my review\n{"verdict":"approved","issues":[],"summary":"ok"}\nthanks');
    expect(r.verdict).toBe('approved');
  });

  it('prose with no verdict in it still refuses — nothing is invented', () => {
    const r = run('I could not review this change because the files were not present.');
    expect(r.verdict).toBe('changes_requested');
    expect(r.reviewIncomplete).toBe(true);
  });

  it('a fragment that is not a verdict object refuses too', () => {
    const r = run('ummary":"looks fine to me"}');
    expect(r.reviewIncomplete).toBe(true);
  });
});
