/**
 * Two fixes from the deep-dive (2026-07-23):
 *
 *  (A) Two-phase detective. A reasoning model reliably EXPLORES but does not
 *      reliably switch to emitting JSON in the same turn — live it ended on
 *      "Now let me read the full X to understand…" and hit the iteration cap
 *      mid-sentence, so there was no JSON to parse/persist. Fix: phase 1 explores
 *      (tools); if it ends in prose, phase 2 is a NO-TOOLS extraction turn whose
 *      only possible action is to emit the JSON from the investigation text.
 *
 *  (B) ac-gate enrichment must not inject a mechanism. The ingest-time AC
 *      enrichment rewrote a symptom AC into "calculates the discount for the
 *      return trip INDEPENDENTLY … for each line item" — which primed the
 *      detective toward the WRONG halve/split fix. Enriched ACs must describe
 *      WHAT to verify, never HOW to implement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const specSrc = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const acGateSrc = readFileSync(join(ROOT, 'orchestrations/scripts/lib/ac-gate.js'), 'utf8');

describe('(A) two-phase detective — explore then no-tools extraction', () => {
  it('has a phase-2 extraction that runs WITHOUT tools (no AI_GATE_ALLOW_TOOLS)', () => {
    expect(specSrc).toMatch(/PHASE 2 — EXTRACT \(no tools\)/);
    expect(specSrc).toMatch(/A code investigation of a bug produced the analysis below/);
    // the extract call must NOT set AI_GATE_ALLOW_TOOLS (so ai-run.sh adds --no-tools)
    expect(specSrc).toMatch(/No AI_GATE_ALLOW_TOOLS → ai-run\.sh adds --no-tools → pure extraction/);
  });

  it('only runs phase 2 when phase 1 produced prose (no JSON) and did not just hit the iteration cap', () => {
    expect(specSrc).toMatch(/findings === null && out && out\.trim\(\) && !\/reached maximum iterations\/i\.test\(out\)/);
  });

  it('logs when phase-2 recovers a fix site from a narrative phase-1 answer', () => {
    expect(specSrc).toMatch(/phase-2 extraction recovered .* fix-site\(s\) for .* from a narrative phase-1 answer/);
  });

  it('phase 2 reuses the same parse + salvage path (findings feed the same persistence)', () => {
    expect(specSrc).toMatch(/findings = parseFindings\(out2\)/);
    expect(specSrc).toMatch(/const out2 = await runClaude\([\s\S]*salvageOutputOnFailure: true/);
  });
});

describe('(B) ac-gate enrichment forbids mechanism injection', () => {
  it('the classification/enrichment prompt bans prescribing a mechanism', () => {
    expect(acGateSrc).toMatch(/ENRICHMENT RULE/);
    expect(acGateSrc).toMatch(/OBSERVABLE BEHAVIOR to VERIFY — never HOW to implement/);
    expect(acGateSrc).toMatch(/calculate independently.*split.*halve/is);
  });

  it('the from-scratch elaboration prompt carries the same no-mechanism rule', () => {
    expect(acGateSrc).toMatch(/Describe WHAT to verify \(observable behavior\), never HOW to implement/);
  });
});
