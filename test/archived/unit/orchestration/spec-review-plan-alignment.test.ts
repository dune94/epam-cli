/**
 * "Why can't the reviewer take detective outputs and agentically review, rather than
 * relying on a regex" — fair challenge. A term-overlap check cannot tell a JUSTIFIED
 * pivot ("useContent turned out to be a dead end; the real integration point is the
 * SSR data-fetching function that builds the props useContent reads") from genuine,
 * unexplained drift. Only judgment can tell those apart.
 *
 * So the deterministic check (checkPlanExecutionAlignment, detective-plan-execution-
 * alignment.test.ts) is repositioned: it is no longer a verdict, it is PRECOMPUTED
 * EVIDENCE handed to SPEC_REVIEW — the same architecture this file already uses for
 * manifestEvidence() ("MANIFEST EVIDENCE has already been gathered from the repository
 * for you... you do not need to check the filesystem; it has been checked"). The
 * reviewer is the one that decides whether a flagged mismatch is real.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

function extractFunctionBody(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(0);
  const end = SRC.indexOf('\n}', start) + 2;
  return SRC.slice(start, end);
}

describe('buildReviewPayload — the reviewer receives the detective\'s answer AND its plan', () => {
  it('THE GAP: fixSiteAnalysis is not in the payload today', () => {
    // This documents the state BEFORE the fix in this same commit — buildReviewPayload's
    // object literal must now include fixSiteAnalysis for the reviewer to judge it at all.
    const body = extractFunctionBody('buildReviewPayload');
    expect(body, 'the reviewer cannot judge what it never receives').toMatch(/fixSiteAnalysis/);
  });

  it('includes plan-alignment evidence per story, not a bare verdict', () => {
    const body = extractFunctionBody('buildReviewPayload');
    expect(body).toMatch(/planAlignmentEvidence|readLatestDetectivePlan/);
  });
});

describe('the brownfield review criteria ask the reviewer to JUDGE alignment, not trust a flag', () => {
  it('instructs the reviewer to weigh whether a deviation is justified', () => {
    const start = SRC.indexOf('For each story, evaluate the quality of the collaborative spec work:\n1. Did both agents');
    expect(start, 'brownfield reviewCriteria block not found').toBeGreaterThan(0);
    const end = SRC.indexOf('`\n      : `For each story', start);
    const block = SRC.slice(start, end === -1 ? start + 2000 : end);
    expect(
      block,
      'the reviewer must be told to use judgment on the evidence, not just repeat it',
    ).toMatch(/plan/i);
    expect(block).toMatch(/justif/i);
  });

  it('the SPEC_REVIEW JSON schema carries the reviewer\'s own alignment verdict', () => {
    const schemaIdx = SRC.indexOf('"verdict":"approved|needs_review"');
    expect(schemaIdx).toBeGreaterThan(0);
    const nearby = SRC.slice(schemaIdx, schemaIdx + 400);
    expect(nearby, 'the reviewer\'s judgment must be captured as structured output, not just prose').toMatch(/planAlignment/);
  });
});
