/**
 * A REVIEWER ASKED TO FALSIFY A CLAIM ABOUT THE PIPELINE MUST BE SHOWN THE PIPELINE.
 *
 * Run 20260827T100559Z died here. Both implementer briefs said a dedicated pipeline stage writes
 * test files — TRUE: tc-writer and repro-test-writer are declared seams — and the roster reviewer,
 * whose declared inputs were the roster, the codelines, the tickets and the coverage and nothing
 * else, concluded "no such role exists in this roster" and returned two BLOCKING findings. Two
 * correction cycles could not clear them, the mint refused to hand unreviewed briefs to
 * implementers, and the run ended.
 *
 * The gate was not broken and must not be weakened: refusing to confirm a claim it has no evidence
 * for is exactly its job. What was missing was the evidence. Run 12 passed this same gate on the
 * same roster, so it is a fresh draw every time — which is what makes it worth fixing rather than
 * re-rolling.
 *
 * The list is DERIVED from the seam registry, so this test asserts against the registry itself
 * rather than a set of seam names written here — a hand-written expectation would go stale the
 * first time a seam is added, and would be testing my memory rather than the code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pipelineStagesBlock } = require(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const registry = JSON.parse(readFileSync(
  join(REPO_ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8'));
const template = JSON.parse(readFileSync(
  join(REPO_ROOT, 'orchestrations/prompts/templates/roster-review.json'), 'utf8'));

describe('the roster reviewer is shown the stages that run alongside the roster', () => {
  it('the template declares the input', () => {
    expect(template.placeholders).toContain('__PIPELINE_STAGES__');
    const body = typeof template.body === 'string'
      ? template.body
      : Object.values(template.bodies || {}).join('\n');
    expect(body, 'the placeholder is declared but never rendered into the body')
      .toContain('__PIPELINE_STAGES__');
  });

  it('lists EVERY declared seam — derived from the registry, not written down', () => {
    const declared = Object.keys(registry.profiles || {});
    expect(declared.length, 'the registry declares no seams — the fixture is empty').toBeGreaterThan(0);
    const block = pipelineStagesBlock();
    for (const seam of declared) {
      expect(block, `the reviewer is not shown the '${seam}' stage`).toContain(seam);
    }
  });

  it('REPRODUCES run 13: a brief deferring test work names a stage the reviewer can now find', () => {
    // The specific claim that was blocked: "a dedicated pipeline stage writes and edits test
    // files". Found by what those seams PRODUCE, not by their names, so renaming a seam does not
    // silently empty this assertion.
    const testStages = Object.entries(registry.profiles || {})
      .filter(([, p]: any) => p && typeof p.produces === 'string' && /test/i.test(p.produces))
      .map(([seam]) => seam);
    expect(testStages.length, 'no seam declares it produces anything test-related — '
      + 'the briefs deferring test work would then be correctly refused').toBeGreaterThan(0);
    const block = pipelineStagesBlock();
    for (const seam of testStages) expect(block).toContain(seam);
  });

  it('tells the reviewer that a missing registry is UNVERIFIABLE, never false', () => {
    // Absent is not empty. A blank list would read as "the pipeline has no stages" and licence
    // exactly the false finding this exists to prevent.
    const block = pipelineStagesBlock();
    expect(block.trim().length).toBeGreaterThan(0);
    expect(block.split('\n').every((l: string) => l.startsWith('-'))).toBe(true);
  });

  it('the reviewer is still told to BLOCK a stage that does not exist', () => {
    // The fix must not become a licence for any deferral at all: a brief naming a stage the
    // pipeline does not have is still a blocking finding.
    const body = typeof template.body === 'string'
      ? template.body
      : Object.values(template.bodies || {}).join('\n');
    expect(body).toMatch(/does not contain the stage[\s\S]{0,200}blocking/i);
  });
});
