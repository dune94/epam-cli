/**
 * Root cause of a live defect (found 2026-07-07): the spec-validator gate
 * (Step 4.2b) correctly identified SKY-004-impl/SKY-004-test as "fail"
 * (missing /search, /cheapest, and dashboard entirely — overallCompliance
 * 15%/50%) but the pipeline logged it as a generic "no story data" WARN and
 * let the phase pass. Root cause: `python3 - '$spec_log' <<...` single-quoted
 * the variable — bash never expanded it, so python3 received the LITERAL
 * 8-character string "$spec_log" as sys.argv[1], not the real log path.
 * open(sys.argv[1]) then raised FileNotFoundError on every single run,
 * caught by the blanket `except Exception: print('error')`, which maps
 * straight to the same "no story data" warning regardless of what the
 * spec-validator agent actually found. The real spec-validator output was
 * never once actually parsed before this fix.
 *
 * Fixed: double-quote so bash expands the variable into the real path.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('run-agent-orchestration.sh — spec-validator log path quoting', () => {
  it('does NOT single-quote $spec_log (the exact live bug — bash never expands single quotes)', () => {
    expect(orchSrc).not.toMatch(/python3 - '\$spec_log'/);
  });

  it('double-quotes $spec_log so bash expands it to the real path', () => {
    expect(orchSrc).toMatch(/python3 - "\$spec_log"/);
  });
});

/**
 * Extracts the exact python extractor between its heredoc boundaries so these
 * tests exercise the REAL parsing logic, not a reimplementation.
 */
function extractSpecValidatorPython(): string {
  const startMarker = "<<'SPEC_EXTRACTOR_PY'";
  const start = orchSrc.indexOf(startMarker);
  if (start === -1) throw new Error('start marker not found');
  const bodyStart = start + startMarker.length;
  const end = orchSrc.indexOf('\nSPEC_EXTRACTOR_PY', bodyStart);
  if (end === -1) throw new Error('end marker not found');
  return orchSrc.slice(bodyStart, end);
}

function runExtractor(logContent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-validator-test-'));
  try {
    const pyScript = join(dir, 'extract.py');
    writeFileSync(pyScript, extractSpecValidatorPython());
    const logFile = join(dir, 'spec-validator-core.log');
    writeFileSync(logFile, logContent);
    return execFileSync('python3', [pyScript, logFile], { encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('spec-validator extractor — REAL execution against the actual live output that exposed the bug', () => {
  it('correctly counts 2 failing stories from a real multi-story payload (SKY-004-impl and SKY-004-test both "fail")', () => {
    const realFixture = `\`\`\`json
{
  "agent": "spec-validator",
  "phase": "core",
  "stories": [
    { "storyId": "SKY-002-impl", "criteria": [], "overallCompliance": 100, "verdict": "pass" },
    { "storyId": "SKY-003-impl", "criteria": [], "overallCompliance": 100, "verdict": "pass" },
    {
      "storyId": "SKY-004-impl",
      "criteria": [
        { "text": "GET /search with valid params returns 200", "status": "unmet", "evidence": "No /search route registered", "gaps": "Endpoint not implemented" }
      ],
      "overallCompliance": 15,
      "verdict": "fail"
    },
    {
      "storyId": "SKY-004-test",
      "criteria": [
        { "text": "tests cover actual endpoint behaviors", "status": "unmet", "evidence": "tests only assert 404s", "gaps": "reverse-validates non-implementation" }
      ],
      "overallCompliance": 50,
      "verdict": "fail"
    }
  ],
  "overallVerdict": "fail"
}
\`\`\``;
    const result = runExtractor(realFixture);
    expect(result).toBe('2');
  });

  it('returns 0 (pass) when every story passes', () => {
    const allPass = `{"stories":[{"storyId":"SKY-001","verdict":"pass"},{"storyId":"SKY-002","verdict":"pass"}],"overallVerdict":"pass"}`;
    expect(runExtractor(allPass)).toBe('0');
  });

  it('returns "no-json" when the agent produced no story/verdict data at all (no storyId/stories substring)', () => {
    expect(runExtractor('The agent rambled and never produced any structured output.')).toBe('no-json');
  });

  it('returns "no-data" when stories/storyId is present but there is no verdict field at all', () => {
    expect(runExtractor('{"stories": [{"storyId": "SKY-004", "criteria": []}]}')).toBe('no-data');
  });

  it('treats a top-level overallVerdict:warn with no per-story fails as 0 (non-blocking)', () => {
    const warnCase = `{"stories":[{"storyId":"SKY-001","verdict":"partial"}],"overallVerdict":"warn"}`;
    expect(runExtractor(warnCase)).toBe('0');
  });

  it('handles unescaped-newline malformed JSON gracefully via line-level regex, not full json.loads', () => {
    // The spec-validator agent frequently emits JSON with literal newlines inside
    // string values — this must still be parseable since the extractor uses
    // regex, not a strict JSON parser.
    const malformed = `{"stories":[{"storyId":"SKY-004","criteria":[{"text":"multi\nline\nvalue"}],"verdict":"fail"}],"overallVerdict":"fail"}`;
    expect(runExtractor(malformed)).toBe('1');
  });
});
