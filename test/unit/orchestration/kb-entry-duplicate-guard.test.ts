/**
 * run_failure_analyst's "kb" case must not append a duplicate (or
 * near-duplicate) entry to a role's KB-<role>.md file.
 *
 * Root cause this fixes (found live via manual audit, 2026-07-12,
 * tier3-travel-app run): unlike the "skill" case (which does an exact-
 * duplicate grep against the FULL existing profile text before ever calling
 * the reviewer — see skill-note-duplicate-fallback.test.ts), the "kb" case
 * had NO duplicate check at all. It only fed the reviewer the LAST 6 LINES
 * of the KB file (`tail -6 "$kb_file"`) as dedup context and relied
 * entirely on the LLM reviewer's subjective judgment for everything older
 * than that. Live evidence: KB-typescript-engineer.md accumulated 4 reworded
 * variants of the exact same "verify test-file imports are in package.json
 * devDependencies before writing tests" rule, all appended within a single
 * 5-minute window (2026-07-02 18:36-18:40) — the LLM reviewer approved each
 * one as "not a duplicate" because the wording differed each time, even
 * though the underlying lesson was identical.
 *
 * Fix: check the candidate note against the FULL existing kb_file content
 * (not just tail -6) for an exact substring match BEFORE ever calling the
 * reviewer — mirroring the skill_note fix exactly. This catches the exact-
 * repeat case (a model literally re-deriving the same wording); genuine
 * near-duplicate rewording is a separate, harder problem left to the
 * reviewer's own judgment (same scope boundary the skill_note fix drew).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

function extractKbCaseBody(): string {
  const start = claudeSrc.indexOf('                kb)');
  const end = claudeSrc.indexOf('\n                tool)');
  return claudeSrc.slice(start, end);
}

describe('kb-entry duplicate guard — wiring (static)', () => {
  it('checks the candidate note against the FULL kb_file content BEFORE calling run_change_with_reviewer_retry', () => {
    const body = extractKbCaseBody();
    const dupIdx = body.indexOf('grep -qF -- "$short_note" "$kb_file"');
    const reviewerIdx = body.indexOf('_kb_review_verdict=$(run_change_with_reviewer_retry');
    expect(dupIdx).toBeGreaterThan(-1);
    expect(reviewerIdx).toBeGreaterThan(dupIdx);
  });

  it('logs and skips rather than persisting via either the normal or unreviewed-fallback path', () => {
    const body = extractKbCaseBody();
    const idx = body.indexOf('grep -qF -- "$short_note" "$kb_file"');
    const block = body.slice(idx, idx + 300);
    expect(block).toMatch(/exact duplicate of an existing (KB )?(entry|note)/i);
  });
});

describe('run_failure_analyst kb case — REAL execution', () => {
  function run(opts: { existingKbContent: string; skillNote: string; reviewerVerdict: 'pass' | 'fail' }): {
    kbAfter: string;
    logOutput: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'kb-dup-'));
    try {
      const kbPath = join(dir, 'KB-test-engineer.md');
      writeFileSync(kbPath, opts.existingKbContent);

      const kbCaseBody = extractKbCaseBody();
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          'log() { echo "LOG: $*"; }',
          'warning() { echo "WARN: $*"; }',
          `SCRIPT_DIR=${JSON.stringify(join(dir, 'scripts'))}`,
          `story_role="test-engineer"`,
          `story_id="SKY-003-test"`,
          `skill_note=${JSON.stringify(opts.skillNote)}`,
          '_profile_updated=""',
          // dirname "$SCRIPT_DIR")/agents must resolve to $dir/agents -- put the
          // real KB file there.
          `mkdir -p ${JSON.stringify(join(dir, 'agents'))}`,
          `cp ${JSON.stringify(kbPath)} ${JSON.stringify(join(dir, 'agents', 'KB-test-engineer.md'))}`,
          'run_change_with_reviewer_retry() {',
          `  printf '%s' "$4" > "\${TMPDIR:-/tmp}/.reviewer-retry-text-$$"`,
          `  echo ${opts.reviewerVerdict}`,
          '}',
          'run_kb_case() {',
          'case "kb" in',
          kbCaseBody,
          'esac',
          '}',
          'run_kb_case',
        ].join('\n'),
      );
      const logOutput = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const kbAfter = readFileSync(join(dir, 'agents', 'KB-test-engineer.md'), 'utf8');
      return { kbAfter, logOutput };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: a candidate note identical to an EXISTING (not just last-6-lines) entry is NOT re-appended', () => {
    const note = 'Before writing any *.test.ts that imports a library, verify that library is listed in package.json devDependencies.';
    // Existing entry sits further back than tail -6 would reach (padded with
    // filler entries), matching the live shape where the duplicate wasn't
    // caught because it wasn't in the reviewer's narrow lookback window.
    const filler = Array.from({ length: 8 }, (_, i) => `- [2026-01-0${(i % 9) + 1}T00:00:00Z] Filler entry ${i}.\n`).join('\n');
    const existingKbContent = `${filler}\n- [2026-07-02T18:36:02Z] ${note}\n`;
    const { kbAfter, logOutput } = run({
      existingKbContent,
      skillNote: note,
      reviewerVerdict: 'pass', // even if the reviewer would approve it, the deterministic check must catch it first
    });
    const occurrences = (kbAfter.match(/verify that library is listed in package\.json devDependencies/g) || []).length;
    expect(occurrences).toBe(1); // still just the original
    expect(logOutput).toMatch(/exact duplicate/);
  });

  it('still persists a genuinely NEW, non-duplicate note normally', () => {
    const { kbAfter } = run({
      existingKbContent: '- [2026-01-01T00:00:00Z] Some unrelated pre-existing note.\n',
      skillNote: 'Always export a main function from CLI entry points for testability',
      reviewerVerdict: 'pass',
    });
    expect(kbAfter).toMatch(/Always export a main function/);
  });
});
