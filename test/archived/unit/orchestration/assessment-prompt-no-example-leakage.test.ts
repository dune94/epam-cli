/**
 * The assessment copied its own examples as findings, and disarmed the QA gates.
 *
 * Live AMSD-2041 run 4, 2026-07-28, against next.gotransit.com (a Next.js site).
 * Step 3 PASSED and applied 4 changes. Among them, written into sast-sentinel:
 *
 *   "Only report findings on source files in the authorized list: src/cli.ts,
 *    src/api.ts, src/utils.ts, src/index.ts. Findings about other files are
 *    hallucinations and must be suppressed."
 *
 * All four files are MISSING from that repository. The instruction tells the
 * security gate to suppress every finding it could possibly make. review-ranger
 * got the equivalent. The gates were not bypassed — they were told to ignore
 * their own results.
 *
 * TWO DISTINCT CAUSES, both in the prompt:
 *
 * 1. The step-5 "examples of the reasoning required" were seven concrete
 *    travel-app scenarios — node-fetch type conflicts, vi.stubGlobal mocking,
 *    process.stderr.write vs console.error, CLI argv parsing, an Express route
 *    handler. The agent reproduced them verbatim as if they were THIS story's
 *    pitfalls. They are also what put Skyscanner content into the shared
 *    profiles in the first place; cleaning that file (625d170) treated the
 *    symptom while the generator kept producing it.
 *
 * 2. Steps 5b(b) and 5b(c) asked the agent to produce "the exact list of source
 *    files it is authorized to report findings on" and "the exact list of
 *    exported symbols". An LLM asked to enumerate a filesystem it cannot
 *    reliably read will invent a plausible list — and a fabricated allowlist is
 *    worse than none, because it reads as authoritative scoping.
 *
 * The examples now teach the SHAPE of the reasoning without supplying content to
 * copy, and enumeration of real files/symbols is not asked of the model at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

function prompt(): string {
  const i = src.indexOf('You are the skill assessment agent running in PRE-PHASE mode');
  expect(i, 'assessment prompt not found').toBeGreaterThan(-1);
  const m = /\nPROMPT_HEADER\n/.exec(src.slice(i));
  return src.slice(i, i + (m ? m.index : 12000));
}

describe('the examples cannot be mistaken for findings', () => {
  it('carries no stack-specific example content to copy', () => {
    // Each of these was reproduced verbatim into a real client run's profiles.
    const leaks = ['node-fetch', 'vi.stubGlobal', 'process.stderr.write',
                   'do-while', 'Express route handler', 'cli.ts'];
    const found = leaks.filter((l) => prompt().includes(l));
    expect(found,
      `the prompt still supplies concrete pitfalls the agent can copy instead of ` +
      `reasoning: ${found.join(', ')}`)
      .toEqual([]);
  });

  it('tells the agent the examples are a method, not an answer', () => {
    expect(prompt(),
      'nothing stops the agent reproducing an illustration as a finding')
      .toMatch(/do not copy|illustrat|not findings|shape of the reasoning/i);
  });

  it('still teaches the inference the step exists to produce', () => {
    // Removing the examples entirely would gut the step — it must still ask for
    // pitfalls inferred from THIS story's code, not a generic checklist.
    expect(prompt(), 'the proactive inference instruction was lost')
      .toMatch(/infer|anticipate|pitfall/i);
  });
});

describe('the model is not asked to enumerate a filesystem it cannot read', () => {
  it('does not ask for an authorized source-file list', () => {
    expect(prompt(),
      'the agent is still asked to produce a file allowlist, which it fabricated ' +
      '— naming four files that do not exist and telling SAST to suppress ' +
      'everything else')
      .not.toMatch(/exact list of source files/i);
  });

  it('does not ask for an exported-symbol list', () => {
    expect(prompt(), 'the agent is still asked to enumerate exported symbols')
      .not.toMatch(/exact list of exported symbols/i);
  });

  it('does not let a QA gate be told to suppress its own findings', () => {
    // This is the load-bearing assertion: whatever else the step does, it must
    // not be able to instruct a gate to discard results.
    expect(prompt(),
      'the prompt can still produce a rule that suppresses gate findings')
      .not.toMatch(/must be suppressed/i);
  });
});
