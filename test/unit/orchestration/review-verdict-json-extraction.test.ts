/**
 * Root cause of a live defect (found 2026-07-07): the tier3 relaunch's core-phase
 * code review actually returned "verdict": "changes_requested" with real
 * blocker-severity issues (hardcoded API key in server.ts, missing input
 * validation, etc.) for SKY-002/003/004 — but the pipeline logged every single
 * one as "approved — no issues found" and sent approval messages to the
 * implementing agents.
 *
 * Root cause: the JSON-verdict extraction in team-lead-review.sh (and the
 * identical copy-pasted logic in code-review-cycle.sh, plus claude.sh's newer
 * review_and_correct_plan()) assumed a FLAT, single-line JSON object:
 *   - `grep -o '{.*"verdict".*}'` matches per-line; a pretty-printed response
 *     never has both '{' and matching '}' on one line.
 *   - The python regex fallback `\{[^{}]*"verdict"[^{}]*\}` structurally cannot
 *     span nested braces ([^{}]* excludes brace characters), and every real
 *     changes_requested response has a nested "issues": [{...}, {...}] array
 *     between the outer braces.
 * Both silently produced no match on every real multi-issue review, falling
 * through to the hardcoded {"verdict":"approved","issues":[]} default.
 *
 * Fixed by replacing both extraction paths with Python's
 * json.JSONDecoder.raw_decode from the first '{' — this correctly parses a
 * nested JSON object regardless of pretty-printing/whitespace, since it's a
 * real parser, not a regex approximation.
 *
 * These tests run the ACTUAL extraction snippet from each fixed file (not a
 * reimplementation) against the real saved SKY-002 review-agent log content
 * that exposed the bug live, plus flat/garbage-input edge cases.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');

const REAL_NESTED_REVIEW_OUTPUT = `{
    "verdict": "changes_requested",
    "issues": [
        {
            "severity": "blocker",
            "file": "/tmp/skyscanner-app/src/skyscanner/client.ts",
            "line": 1,
            "description": "Missing TypeScript types for function parameters and return values.",
            "suggestedFix": "Add explicit types."
        },
        {
            "severity": "major",
            "file": "/tmp/skyscanner-app/src/server.ts",
            "line": 1,
            "description": "RAPIDAPI_KEY is hardcoded in source code, a security violation.",
            "suggestedFix": "Read from environment only."
        }
    ],
    "summary": "Several blocker/major issues must be fixed before merge."
}`;

function extractPythonBlock(fileText: string, startMarker: string): string {
  const start = fileText.indexOf(startMarker);
  if (start === -1) throw new Error(`start marker not found: ${startMarker}`);
  // The python source is delimited by `python3 -c "` ... `"` immediately
  // followed by ` 2>/dev/null`. Find that closing boundary.
  const pyStart = fileText.indexOf('python3 -c "', start);
  const pyBodyStart = pyStart + 'python3 -c "'.length;
  const pyEnd = fileText.indexOf('\n" 2>/dev/null', pyBodyStart);
  if (pyEnd === -1) throw new Error('python block end marker not found');
  return fileText.slice(pyBodyStart, pyEnd);
}

function runExtraction(pySource: string, stdinText: string): string {
  // The embedded python uses bash double-quote escaping (\" for literal ").
  const unescaped = pySource.replace(/\\"/g, '"');
  const dir = mkdtempSync(join(tmpdir(), 'review-verdict-extract-'));
  try {
    const scriptPath = join(dir, 'extract.py');
    writeFileSync(scriptPath, unescaped);
    return execFileSync('python3', [scriptPath], {
      input: stdinText,
      encoding: 'utf8',
    }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('team-lead-review.sh — REVIEW_JSON extraction (REAL python source, real nested review output)', () => {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh'), 'utf8');
  const py = extractPythonBlock(src, '# Extract JSON verdict from output.');

  it('correctly parses a real pretty-printed, nested changes_requested response (the actual live bug shape)', () => {
    const out = runExtraction(py, REAL_NESTED_REVIEW_OUTPUT);
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('changes_requested');
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[0].severity).toBe('blocker');
  });

  it('correctly parses a flat single-line approved response', () => {
    const out = runExtraction(py, '{"verdict":"approved","issues":[],"summary":"looks good"}');
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('approved');
  });

  it('falls back to the SAFE default (changes_requested, never approved) on non-JSON/garbage output', () => {
    // The safe default is to BLOCK, not silently approve — an unparseable
    // verdict means the change was not reviewed (found live 2026-07-23).
    const out = runExtraction(py, 'the model rambled and never produced JSON at all');
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('changes_requested');
  });

  it('handles prose BEFORE the JSON block (model ignored "ONLY JSON" instruction partially)', () => {
    const out = runExtraction(py, `Here is my review:\n\n${REAL_NESTED_REVIEW_OUTPUT}`);
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('changes_requested');
    expect(parsed.issues).toHaveLength(2);
  });
});

// Live AMSD-2041 defect, 2026-07-31: review-agent produced an otherwise
// complete, valid, 10-blocker review — but ONE field had a stray `"`
// immediately after a number, before the delimiter: `"line":130",` instead
// of `"line":130,`. json.JSONDecoder.raw_decode correctly rejects this (it
// IS invalid JSON), and the whole review — real, substantive findings about
// missing live_preview config, absent tests, etc. — was discarded as
// "review output unparseable", silently turning a legitimate rejection into
// a reviewer-failure escalation that blocked the run needing human
// intervention. A stray quote directly after a digit, immediately before a
// comma/brace, can never appear in valid JSON — so a narrow repair (strip
// exactly that pattern) recovers the real verdict without risking any
// legitimate JSON.
const STRAY_QUOTE_AFTER_NUMBER = `{
    "verdict": "changes_requested",
    "issues": [
        {
            "severity": "blocker",
            "file": "src/context/ContentstackContext.tsx",
            "line":130",
            "description": "Uses hashchange events instead of the SDK livePreview callback."
        }
    ],
    "summary": "Missing live_preview configuration and SDK callback usage."
}`;

describe('team-lead-review.sh — recovers a valid verdict despite one malformed field (RG stray-quote fix)', () => {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh'), 'utf8');
  const py = extractPythonBlock(src, '# Extract JSON verdict from output.');

  it('recovers the real verdict/issues from an otherwise-valid JSON with a stray quote after a number', () => {
    const out = runExtraction(py, STRAY_QUOTE_AFTER_NUMBER);
    const parsed = JSON.parse(out);
    expect(parsed.verdict, `expected the real verdict, got the unparseable fallback: ${out}`).toBe('changes_requested');
    expect(parsed.summary).not.toMatch(/unparseable/i);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].description).toMatch(/hashchange/);
  });
});

describe('code-review-cycle.sh — recovers a valid verdict despite one malformed field (RG stray-quote fix)', () => {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/code-review-cycle.sh'), 'utf8');
  const py = extractPythonBlock(src, '# Same bug/fix as team-lead-review.sh');

  it('correctly parses the real nested changes_requested shape', () => {
    const out = runExtraction(py, REAL_NESTED_REVIEW_OUTPUT);
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('changes_requested');
    expect(parsed.issues).toHaveLength(2);
  });

  it('recovers the real verdict/issues from an otherwise-valid JSON with a stray quote after a number', () => {
    const out = runExtraction(py, STRAY_QUOTE_AFTER_NUMBER);
    const parsed = JSON.parse(out);
    expect(parsed.verdict, `expected the real verdict, got the unparseable fallback: ${out}`).toBe('changes_requested');
    expect(parsed.summary).not.toMatch(/unparseable/i);
  });

  it('falls back to the SAFE default (changes_requested, never approved) on garbage input', () => {
    const out = runExtraction(py, 'not json at all');
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('changes_requested');
  });
});

describe('claude.sh — review_and_correct_plan() review_json extraction (REAL python source, same fix)', () => {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
  const py = extractPythonBlock(src, '# Robust JSON extraction (not a flat-object regex');

  it('correctly parses a pretty-printed mismatch verdict', () => {
    const out = runExtraction(
      py,
      `{
  "verdict": "mismatch",
  "corrections": "Use SkyscannerClient from SKY-002's real contract, not a hallucinated path."
}`,
    );
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('mismatch');
  });

  it('correctly parses a flat single-line ok verdict', () => {
    const out = runExtraction(py, '{"verdict":"ok"}');
    const parsed = JSON.parse(out);
    expect(parsed.verdict).toBe('ok');
  });

  it('returns empty string (not a fabricated verdict) on non-JSON input — caller treats this as "skip review, trust the plan"', () => {
    const out = runExtraction(py, 'no json here');
    expect(out).toBe('');
  });
});
