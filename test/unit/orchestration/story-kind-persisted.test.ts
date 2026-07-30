/**
 * The spec pass must WRITE its classification, not just use it in passing.
 *
 * Every story reached the PRD with storyKind:null. The spec agent classifies
 * each story "defect" or "novel" — every plan in every lane said "novel" for
 * AMSD-2041, and the detective is explicit that a novel story has no fix site —
 * and applySpecChanges persisted acceptanceCriteria, description, title,
 * technicalNotes, status and completed, but never storyKind.
 *
 * Three consumers read the field and were therefore dead code:
 *   classify_ladder_tier      novel brownfield -> high ladder
 *   resolve_model_from_story  novel brownfield -> high model
 *   the bug-reproduction gate skip novel stories
 *
 * All three were verified against synthetic PRDs where the field was set BY
 * HAND. Nothing checked the producer. So a live run classified the story novel
 * in every lane, started it on the cheapest model anyway, and would have gated
 * it as a defect. This test is the producer-side check that was missing — it
 * exists because "the consumer works" was mistaken for "the feature works",
 * twice in one day.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(RUNNER);
const SRC = readFileSync(RUNNER, 'utf8');

function applied(payloadKind?: string) {
  const story: Record<string, unknown> = { id: 'S-1', acceptanceCriteria: ['a'] };
  const payload: Record<string, unknown> = { storyId: 'S-1', agent: 'openspec', acceptanceCriteria: ['a'] };
  if (payloadKind !== undefined) payload.storyKind = payloadKind;
  mod.applySpecChanges(story, payload, {});
  return story.storyKind;
}

describe('the classification survives into the story', () => {
  it('persists novel — the case three fixes depend on', () => {
    expect(applied('novel'), 'storyKind is dropped, so the ladder, model and repro-gate fixes are dead code')
      .toBe('novel');
  });

  it('persists defect', () => {
    expect(applied('defect')).toBe('defect');
  });

  it('does not invent a classification when the agent omits it', () => {
    // Defaulting here would silently mark unclassified work as one kind or the
    // other, and the consumers treat the two very differently.
    expect(applied(undefined)).toBeUndefined();
  });

  it('ignores a value outside the allowed set', () => {
    expect(applied('something-else')).toBeUndefined();
  });
});

describe('the provider guarantees the field, rather than the prose asking for it', () => {
  it('storyKind is in the bound tool schema', () => {
    // It was requested only in prompt prose. A field the model may or may not
    // volunteer cannot carry three downstream decisions.
    const i = SRC.indexOf('const TOOL_SPEC_AGENT');
    const blk = SRC.slice(i, SRC.indexOf('\n};', i));
    expect(blk, 'storyKind is asked for in prose but not bound at the provider')
      .toMatch(/storyKind:\s*\{[^}]*enum:\s*\[[^\]]*'novel'/);
  });
});
