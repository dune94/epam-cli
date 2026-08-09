/**
 * The prompt-size trimming that protects against oversized retry prompts
 * (found live 2026-07-07 — an unbounded COORDINATOR_PROMPT_AMENDMENT could
 * grow large enough to blow the watchdog timeout) must keep the last 3
 * distinct coordinator-guidance headings, not just the single most recent
 * one.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run):
 * SKY-003-test's retry 0 was correctly diagnosed and given the fix "Do not
 * reuse validation logic across different flags" — persisted to
 * COORDINATOR_PROMPT_AMENDMENT as a "## Self-Heal: Failure Analyst Summary"
 * heading. By retry 5, TWO more headings had accumulated on top of it (a
 * missing-import-path fix, then a missing-main-export fix), pushing the
 * total prompt past the 16000-char trim threshold. The trim kept only the
 * LAST heading (the main-export fix) and discarded the validation-logic
 * heading from the model's view entirely — even though it was still
 * archived in the scratchpad file and the full variable. Retry 5's
 * diagnosis then came back as the EXACT SAME validation-logic-reuse bug
 * from retry 0: "Validation logic incorrectly reuses date validation for
 * adults flag" — the model repeated a mistake it had already been
 * explicitly told to avoid, because that instruction was no longer visible
 * to it.
 *
 * Fix: keep the last 3 distinct headings instead of 1 when trimming — still
 * bounds prompt growth (the original purpose), but gives recent-but-not-
 * newest guidance a few more retries of visibility before it falls out of
 * the window.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

describe('coordinator-guidance trim window — wiring (static)', () => {
  it('keeps the last N headings from config, not just the last 1', () => {
    // Was pinned to the literal `heading_idxs[-3]`. That 3 moved into
    // orchestrations/config/spec-mode-defaults.json (keepRecentSections) so an operator can
    // change it without editing code, and this assertion broke while the behaviour was
    // unchanged. Assert the SHAPE — a configured count, not a baked-in one — and let the
    // real-execution tests below prove the value.
    expect(claudeSrc).toMatch(/heading_idxs\[-KEEP\] if len\(heading_idxs\) >= KEEP/);
    expect(claudeSrc).toMatch(/EPAM_PROMPT_TRIM_KEEP/);
    expect(claudeSrc).not.toMatch(/print\(chr\(10\)\.join\(lines\[heading_idxs\[-1\]:\]\)/);
  });

  it('the warning/heading text reflects "up to 3", not "most recent only"', () => {
    expect(claudeSrc).toMatch(/most recent guidance \(up to 3\)/);
    expect(claudeSrc).toMatch(/showing most recent up to 3/);
    expect(claudeSrc).not.toMatch(/showing most recent only/);
  });
});

describe('coordinator-guidance trim window — REAL execution', () => {
  function extractTrimScript(): string {
    const start = claudeSrc.indexOf('_trimmed_amendment=$(printf');
    // The python begins `import os, sys` since the keep-count started coming from the
    // environment; searching for 'import sys' silently found nothing and every test in this
    // file then ran an EMPTY script and asserted against ''.
    const pyStart = claudeSrc.indexOf('import os, sys', start);
    const pyEnd = claudeSrc.indexOf('" 2>/dev/null', pyStart);
    return claudeSrc.slice(pyStart, pyEnd);
  }

  function runTrim(headings: string[]): string {
    const script = extractTrimScript();
    const input = headings.map((h, i) => `## Heading ${i}\nbody text for heading ${i}`).join('\n');
    // claude.sh passes the keep-count in the environment (EPAM_PROMPT_TRIM_KEEP="$_keep_sections").
    // Without it the extracted script raises KeyError and the failure reads as though the
    // trimmer itself were broken. 3 is the shipped default in spec-mode-defaults.json, which is
    // what these expectations describe.
    return execFileSync('python3', ['-c', script], {
      input, encoding: 'utf8', env: { ...process.env, EPAM_PROMPT_TRIM_KEEP: '3' },
    }).trimEnd();
  }

  it('REPRODUCES the exact live defect and proves the fix: with 3 headings accumulated, the FIRST one is still visible after trimming (previously only the last would survive)', () => {
    const result = runTrim(['validation-logic-reuse fix', 'missing-import-path fix', 'missing-main-export fix']);
    expect(result).toMatch(/## Heading 0/); // the retry-0 fix — must still be visible
    expect(result).toMatch(/## Heading 1/);
    expect(result).toMatch(/## Heading 2/);
  });

  it('with MORE than 3 headings, only the last 3 survive (still bounds growth — the original purpose of this trim)', () => {
    const result = runTrim(['h0', 'h1', 'h2', 'h3', 'h4']);
    expect(result).not.toMatch(/## Heading 0/);
    expect(result).not.toMatch(/## Heading 1/);
    expect(result).toMatch(/## Heading 2/);
    expect(result).toMatch(/## Heading 3/);
    expect(result).toMatch(/## Heading 4/);
  });

  it('with fewer than 3 headings, all of them survive (no regression for the common case)', () => {
    const result = runTrim(['only-heading']);
    expect(result).toMatch(/## Heading 0/);
  });

  it('with no headings at all, falls back to the full text unchanged', () => {
    const script = extractTrimScript();
    const result = execFileSync('python3', ['-c', script], {
      input: 'plain text with no headings', encoding: 'utf8',
      env: { ...process.env, EPAM_PROMPT_TRIM_KEEP: '3' },
    }).trimEnd();
    expect(result).toBe('plain text with no headings');
  });
});
