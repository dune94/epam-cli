/**
 * Full agent audit, 2026-07-31: perf-sentinel's fail-verdict grounding only
 * checked the agent's OWN summary numbers for internal self-consistency
 * (blockerCount>0 and filesAnalysed>0/blockerCount>0 — all read from the
 * SAME JSON blob the agent produced) — unlike its structural sibling
 * fuzz-weaver, which actually executes the agent's own claimed test against
 * the real code before trusting a fail. An agent could hallucinate a
 * self-consistent blockerCount:1 finding with a plausible-sounding
 * description and it would pass grounding and incorrectly block a clean
 * pipeline.
 *
 * Fix: each blocker-severity finding must now include a "codeSnippet" field
 * (the exact flagged line(s), quoted verbatim). Grounding now requires that
 * snippet to be a literal substring of the REAL file's REAL content — same
 * "quote it, then verify the quote" pattern already used for the
 * code-graph-detective's brokenLine field. This test extracts the REAL
 * python verification block embedded in run-agent-orchestration.sh (not a
 * hand-copied duplicate) and runs it against real fixture files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractPerfVerifyPython(): string {
  // Anchored on the agent-specific regex string, not the generic
  // "log_file, project_root = ..." line — review-ranger's and
  // mutant-hunter's grounding blocks (added 2026-07-31, same pattern) share
  // that exact line, so a plain indexOf on it found review-ranger's block
  // first and sliced across multiple PYEOF-delimited scripts into one
  // corrupted string.
  const anchor = orchSrc.indexOf('"agent".*"perf-sentinel"');
  expect(anchor, 'perf-sentinel grounding python block not found — source may have moved').toBeGreaterThan(-1);
  const start = orchSrc.lastIndexOf('import json, sys, re, os', anchor);
  expect(start).toBeGreaterThan(-1);
  const end = orchSrc.indexOf('\nPERF_PYEOF', anchor);
  expect(end).toBeGreaterThan(-1);
  return orchSrc.slice(start, end);
}

function makeFixtureProject(): { root: string; filePath: string; relPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'perf-verify-fixture-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const relPath = 'src/report.ts';
  const filePath = join(root, relPath);
  writeFileSync(
    filePath,
    [
      'export function buildReport(rows: string[][]) {',
      '  const out: string[] = [];',
      '  for (const row of rows) {',
      '    for (const other of rows) {',
      "      out.push(row.join(',') + other.join(','));",
      '    }',
      '  }',
      '  return out;',
      '}',
    ].join('\n'),
  );
  return { root, filePath, relPath };
}

function runVerification(perfLogJson: string, projectRoot: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'perf-verify-run-'));
  try {
    const logPath = join(dir, 'perf-log.txt');
    writeFileSync(logPath, perfLogJson);
    const scriptPath = join(dir, 'verify.py');
    writeFileSync(scriptPath, extractPerfVerifyPython());
    const output = execFileSync('python3', [scriptPath, logPath, projectRoot], { encoding: 'utf8', timeout: 15000 });
    return parseInt(output.trim(), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function perfLog(findings: unknown[]): string {
  return `some preamble text\n{"agent":"perf-sentinel","phase":"core","summary":{"filesAnalysed":1,"findingsCount":${findings.length},"blockerCount":${findings.length},"estimatedStartupImpactMs":0},"findings":${JSON.stringify(findings)},"verdict":"fail"}\ntrailing text`;
}

describe('perf-sentinel grounding — codeSnippet must exist verbatim in the real file', () => {
  it('CONFIRMS a blocker whose codeSnippet is a real, verbatim substring of the real file', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = perfLog([
        {
          severity: 'blocker',
          category: 'complexity',
          file: relPath,
          line: 3,
          codeSnippet: 'for (const other of rows) {',
          description: 'nested loop over rows is O(n^2)',
        },
      ]);
      expect(runVerification(log, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a blocker whose codeSnippet does not appear in the real file (hallucinated)', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = perfLog([
        {
          severity: 'blocker',
          category: 'memory',
          file: relPath,
          line: 12,
          codeSnippet: 'const leak = new Array(1e9).fill(0); // never freed',
          description: 'unbounded memory allocation',
        },
      ]);
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a blocker with no codeSnippet at all', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = perfLog([
        { severity: 'blocker', category: 'complexity', file: relPath, line: 3, description: 'looks slow' },
      ]);
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a blocker pointing at a file that does not exist', () => {
    const { root } = makeFixtureProject();
    try {
      const log = perfLog([
        {
          severity: 'blocker',
          category: 'complexity',
          file: 'src/does-not-exist.ts',
          line: 1,
          codeSnippet: 'anything',
          description: 'phantom file',
        },
      ]);
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a self-consistent-but-ungrounded summary (the OLD bug\'s exact shape) is no longer trusted', () => {
    // Old grounding: real_blockers>0 AND (filesAnalysed>0 OR blockerCount>0) —
    // this exact JSON would have passed under the old check purely because
    // its own summary numbers agree with its own findings array.
    const { root } = makeFixtureProject();
    try {
      const log = `{"agent":"perf-sentinel","phase":"core","summary":{"filesAnalysed":1,"findingsCount":1,"blockerCount":1,"estimatedStartupImpactMs":500},"findings":[{"severity":"blocker","category":"startup","file":"src/report.ts","line":1,"description":"heavy import at module load"}],"verdict":"fail"}`;
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
