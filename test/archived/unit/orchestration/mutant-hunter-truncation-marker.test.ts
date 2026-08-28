/**
 * Full agent audit, 2026-07-31: mutant-hunter's source/test evidence
 * injection silently capped each file at 100/60 lines with no signal to the
 * agent that anything was cut — unlike review-ranger's diff injection
 * (run-agent-orchestration.sh:370-372), which appends a
 * "[TRUNCATED — N total lines...]" marker when its own cap is hit. A file
 * whose relevant logic sits past line 100, or a test whose assertions sit
 * past line 60, was invisible to the agent with no indication anything was
 * missing — it could confidently judge mutations against a partial picture
 * of the code.
 *
 * Fixed by adding the same truncation-marker convention used elsewhere in
 * this file, keyed off the real line count (`wc -l`) of each injected file.
 * This test extracts the REAL bash logic and runs it against real fixture
 * files, both under and over the caps.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractSrcInjectionLoop(): string {
  const start = orchSrc.indexOf('local _src_content=""\n                if [ -n "$_changed_src" ]; then');
  expect(start, 'mutant-hunter src injection loop not found').toBeGreaterThan(-1);
  const end = orchSrc.indexOf('\n                fi\n', start) + '\n                fi\n'.length;
  return orchSrc.slice(start, end);
}

function extractTestInjectionLoop(): string {
  const start = orchSrc.indexOf('local _test_content=""\n                while IFS= read -r _tf; do');
  expect(start, 'mutant-hunter test injection loop not found').toBeGreaterThan(-1);
  const end = orchSrc.indexOf('\n                done <<< "$_test_files"', start) + '\n                done <<< "$_test_files"'.length;
  return orchSrc.slice(start, end);
}

function runSrcInjection(files: { relPath: string; lineCount: number }[], projectRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mutant-src-inject-'));
  try {
    const script = `
PROJECT_ROOT="${projectRoot}"
_changed_src="${files.map((f) => f.relPath).join('\\n')}"
${extractSrcInjectionLoop()}
echo "$_src_content"
`;
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runTestInjection(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mutant-test-inject-'));
  try {
    const script = `
_test_files="${files.join('\\n')}"
${extractTestInjectionLoop()}
echo "$_test_content"
`;
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, script);
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('mutant-hunter source evidence — truncation marker', () => {
  it('appends a TRUNCATED marker when a changed source file exceeds 100 lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutant-src-fixture-'));
    try {
      const relPath = 'src/big.ts';
      writeFileSync(join(dir, 'big.ts'), Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n') + '\n');
      const output = runSrcInjection([{ relPath: 'big.ts', lineCount: 150 }], dir);
      expect(output).toMatch(/\[TRUNCATED — 150 total lines, showing first 100\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT append a marker when the file is under the 100-line cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutant-src-fixture-'));
    try {
      writeFileSync(join(dir, 'small.ts'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
      const output = runSrcInjection([{ relPath: 'small.ts', lineCount: 20 }], dir);
      expect(output).not.toMatch(/TRUNCATED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mutant-hunter test evidence — truncation marker', () => {
  it('appends a TRUNCATED marker when a test file exceeds 60 lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutant-test-fixture-'));
    try {
      const testPath = join(dir, 'big.test.ts');
      writeFileSync(testPath, Array.from({ length: 90 }, (_, i) => `it('case ${i}', () => {})`).join('\n') + '\n');
      const output = runTestInjection([testPath]);
      expect(output).toMatch(/\[TRUNCATED — 90 total lines, showing first 60\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT append a marker when the test file is under the 60-line cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutant-test-fixture-'));
    try {
      const testPath = join(dir, 'small.test.ts');
      writeFileSync(testPath, Array.from({ length: 10 }, (_, i) => `it('case ${i}', () => {})`).join('\n'));
      const output = runTestInjection([testPath]);
      expect(output).not.toMatch(/TRUNCATED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
