/**
 * Important steps must not fail silently — the code-graph-detective centerpiece.
 *
 * Found LIVE (2026-07-23, AMSD-1820 confirmation run): with tools enabled the
 * detective (GLM-5.1) sometimes "answers" by calling WriteFile and returns the
 * tool echo "The file has been written successfully" instead of the JSON array.
 * The old code regex-matched no array and silently returned [] — so the story
 * reached implementation with NO root-cause guidance and nobody knew. THREE
 * failures compounded and none surfaced:
 *   1. detective wandered to a write tool → no JSON → swallowed as silent []
 *   2. issueType arrived null at the PRD (ac-gate dropped it) → #3 anchor no-op
 *   3. the empty fixSiteAnalysis on a defect passed by with no warning
 *
 * This locks in: the detective prompt forbids writing to a file; a JSON-less
 * output triggers a loud retry (not a silent []); ac-gate carries issueType; and
 * a defect with no fix site is loudly surfaced at the spec-pass level.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const specSrc = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const acGateSrc = readFileSync(join(ROOT, 'orchestrations/scripts/lib/ac-gate.js'), 'utf8');

describe('detective prompt — forbids answering by writing a file', () => {
  it('explicitly tells the model NOT to call WriteFile and to emit JSON inline', () => {
    expect(specSrc).toMatch(/Do NOT call WriteFile and do NOT write your answer to any file/);
    expect(specSrc).toMatch(/the pipeline reads your reply text, not a file/);
    expect(specSrc).toMatch(/Use the Bash tool ONLY to run the CodeGraph query/);
  });
});

describe('detective invocation — loud retry instead of silent []', () => {
  it('distinguishes "no JSON at all" (null → retry) from an explicit empty answer', () => {
    // parseFindings returns null when there is no array — the retry signal.
    expect(specSrc).toMatch(/if \(!m\) return null/);
  });

  it('retries with a corrective note when the output had no JSON array', () => {
    expect(specSrc).toMatch(/for \(let attempt = 1; attempt <= maxAttempts; attempt\+\+\)/);
    expect(specSrc).toMatch(/RETRY — your previous reply contained NO JSON array/);
    expect(specSrc).toMatch(/CODEGRAPH_DETECTIVE_MAX_ATTEMPTS/);
  });

  it('logs LOUDLY on a no-JSON output, an empty result, and final exhaustion (never silent)', () => {
    expect(specSrc).toMatch(/produced NO parseable JSON for .* even after the extraction phase/);
    expect(specSrc).toMatch(/returned an EMPTY fix-site list/);
    expect(specSrc).toMatch(/found NO fix site for .* after .* attempts — the implementer will proceed WITHOUT root-cause guidance/);
  });

  it('is structurally fenced to bash-only (EPAM_ALLOWED_TOOLS) so it can never write_file', () => {
    // The allowlist is what stops the detective "answering" by writing a file
    // (the live 2026-07-23 failure); assert the detective actually SETS it.
    expect(specSrc).toMatch(/EPAM_ALLOWED_TOOLS: process\.env\.CODEGRAPH_DETECTIVE_ALLOWED_TOOLS \|\| 'bash'/);
  });

  it('surfaces a defect-with-no-fix-site loudly at the spec-pass level', () => {
    expect(specSrc).toMatch(/DEFECT .* has NO fixSiteAnalysis after the spec pass/);
    // triggered when the ticket is a Bug or openspec classified it a defect
    expect(specSrc).toMatch(/String\(story\.issueType \|\| ''\)\.toLowerCase\(\) === 'bug'\s*\|\|\s*payload\.storyKind === 'defect'/);
  });
});

describe('ac-gate — carries issueType so the #3 anchor is not silently a no-op', () => {
  it('includes issueType in the classification output object', () => {
    expect(acGateSrc).toMatch(/issueType:\s*issue\.issueType \|\| null/);
  });

  it('also carries effort through (parity with the story fields synthesize-prd reads)', () => {
    expect(acGateSrc).toMatch(/effort:\s*issue\.effort/);
  });
});
