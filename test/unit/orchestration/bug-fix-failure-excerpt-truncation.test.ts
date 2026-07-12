/**
 * _create_bug_fix_phase()'s failure_excerpt computation — REAL execution.
 *
 * Root cause this fixes (2026-07-09, full pipeline audit): the excerpt of
 * vitest output included in a bug-fix story's own description was capped at
 * 45 lines (grep -A 40 "$failing_file" | head -45) with no indication of
 * truncation. A genuinely long test failure (multiple assertion failures for
 * the same file, or a long stack trace) could have its actual root cause
 * beyond line 45 silently cut — the resulting bug-fix story would then be
 * given an incomplete picture of what's actually broken.
 *
 * Fix: cap raised to 150 lines, and any actual truncation appends an
 * explicit "[TRUNCATED — N total lines...]" marker to the excerpt text
 * itself, so the bug-fix story's description never silently understates
 * what's missing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH_SH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH_SH, 'utf8');

function extractFailureExcerptBlock(): string {
  const startMarker = 'local failure_excerpt _failure_excerpt_full _failure_excerpt_lines';
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find failure_excerpt block start');
  const endMarker = 'local story_model story_provider';
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('Could not find failure_excerpt block end');
  return src.slice(startIdx, endIdx);
}

describe('_create_bug_fix_phase — failure_excerpt truncation (static)', () => {
  it('cap raised from 45 to 150 lines', () => {
    const block = extractFailureExcerptBlock();
    expect(block).toMatch(/grep -A 150 "\$failing_file"/);
    expect(block).toMatch(/-gt 150/);
    expect(block).toMatch(/head -150/);
    expect(block).not.toMatch(/head -45/);
    expect(block).not.toMatch(/-A 40/);
  });

  it('truncation (if it happens) appends an explicit marker, not silent', () => {
    const block = extractFailureExcerptBlock();
    expect(block).toMatch(/\[TRUNCATED — \$\{?_failure_excerpt_lines\}? total lines/);
  });
});

describe('_create_bug_fix_phase — failure_excerpt, REAL execution', () => {
  function run(vitestOutput: string, failingFile: string): string {
    const block = extractFailureExcerptBlock();
    // `local` (used throughout the extracted block) is only valid inside a
    // function — wrap it in one rather than stripping `local`, so the test
    // exercises the real source unmodified.
    //
    // vitestOutput is written to a file and loaded via `$(cat ...)` rather
    // than embedded as a JSON.stringify'd double-quoted literal: bash does
    // NOT reinterpret `\n` escape sequences inside a double-quoted variable
    // assignment, so embedding it directly collapsed the whole multi-line
    // fixture into one literal-backslash-n line, defeating the `wc -l`
    // line-count check this test exists to exercise.
    const dir = mkdtempSync(join(tmpdir(), 'bug-fix-excerpt-'));
    try {
      const outputFile = join(dir, 'vitest-output.txt');
      writeFileSync(outputFile, vitestOutput);
      const script = [
        `vitest_output=$(cat ${JSON.stringify(outputFile)})`,
        `failing_file=${JSON.stringify(failingFile)}`,
        'run_extracted() {',
        block,
        '  printf "%s" "$failure_excerpt"',
        '}',
        'run_extracted',
      ].join('\n');
      return execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a short failure excerpt (under the cap) passes through with no truncation marker', () => {
    const output = ['FAIL src/foo.test.ts', ...Array.from({ length: 10 }, (_, i) => `  line ${i}`)].join('\n');
    const result = run(output, 'src/foo.test.ts');
    expect(result).not.toMatch(/TRUNCATED/);
    expect(result).toContain('FAIL src/foo.test.ts');
  });

  it('REPRODUCES the exact live defect and proves the fix: a failure spanning more than 150 lines gets an explicit TRUNCATED marker instead of silent loss', () => {
    const output = ['FAIL src/foo.test.ts', ...Array.from({ length: 300 }, (_, i) => `  assertion failure ${i}`)].join('\n');
    const result = run(output, 'src/foo.test.ts');
    expect(result).toMatch(/TRUNCATED — \d+ total lines, only the first 150 shown/);
  });
});
