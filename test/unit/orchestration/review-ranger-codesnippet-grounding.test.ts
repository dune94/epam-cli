/**
 * Full agent audit re-audit, 2026-07-31: review-ranger's fail-verdict
 * enforcement was a bare `grep -q '"verdict":"fail"'` on the agent's own
 * self-reported output — no check that any named `file`/`line` in its
 * findings corresponds to something real on disk. The real git-diff
 * evidence fed into the prompt is real, but nothing stopped the agent from
 * citing a plausible-looking but fabricated file:line and still blocking
 * the pipeline. Same defect class already fixed for perf-sentinel.
 *
 * Fix: each blocker-severity finding must now include a "codeSnippet" field
 * (the exact flagged line(s), quoted verbatim). Grounding requires that
 * snippet to be a literal substring of the REAL file's REAL content — same
 * "quote it, then verify the quote" pattern used for perf-sentinel and the
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

function extractReviewVerifyPython(): string {
  const startMarker = 'log_file, project_root = sys.argv[1], sys.argv[2]';
  const anchor = orchSrc.indexOf('"agent".*"review-ranger"');
  expect(anchor, 'review-ranger grounding python block not found — source may have moved').toBeGreaterThan(-1);
  const start = orchSrc.lastIndexOf('import json, sys, re, os', anchor);
  expect(start).toBeGreaterThan(-1);
  const end = orchSrc.indexOf('\nREVIEW_PYEOF', anchor);
  expect(end).toBeGreaterThan(-1);
  return orchSrc.slice(start, end);
}

function makeFixtureProject(): { root: string; relPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'review-verify-fixture-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const relPath = 'src/handler.ts';
  writeFileSync(
    join(root, relPath),
    [
      'export function handleRequest(req: Request) {',
      '  try {',
      '    return process(req);',
      '  } catch (e) {',
      '    // swallowed',
      '  }',
      '}',
    ].join('\n'),
  );
  return { root, relPath };
}

function runVerification(reviewLogJson: string, projectRoot: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'review-verify-run-'));
  try {
    const logPath = join(dir, 'review-log.txt');
    writeFileSync(logPath, reviewLogJson);
    const scriptPath = join(dir, 'verify.py');
    writeFileSync(scriptPath, extractReviewVerifyPython());
    const output = execFileSync('python3', [scriptPath, logPath, projectRoot], { encoding: 'utf8', timeout: 15000 });
    return parseInt(output.trim(), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function reviewLog(findings: unknown[]): string {
  return `some preamble text\n{"agent":"review-ranger","phase":"core","summary":{"filesReviewed":1,"findingsCount":${findings.length},"blockerCount":${findings.length},"majorCount":0,"minorCount":0},"findings":${JSON.stringify(findings)},"verdict":"fail"}\ntrailing text`;
}

describe('review-ranger grounding — codeSnippet must exist verbatim in the real file', () => {
  it('CONFIRMS a blocker whose codeSnippet is a real, verbatim substring of the real file', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = reviewLog([
        {
          severity: 'blocker',
          category: 'error-handling',
          file: relPath,
          line: 5,
          codeSnippet: '// swallowed',
          description: 'catch block swallows the error silently',
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
      const log = reviewLog([
        {
          severity: 'blocker',
          category: 'api-contract-drift',
          file: relPath,
          line: 20,
          codeSnippet: 'export function renamedHandler(req: Request, res: Response) {',
          description: 'exported signature changed without a test update',
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
      const log = reviewLog([
        { severity: 'blocker', category: 'error-handling', file: relPath, line: 5, description: 'looks like a swallow' },
      ]);
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a blocker pointing at a file that does not exist', () => {
    const { root } = makeFixtureProject();
    try {
      const log = reviewLog([
        {
          severity: 'blocker',
          category: 'error-handling',
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

  it('a self-consistent-but-ungrounded summary is no longer trusted on its own', () => {
    // The OLD enforcement was a bare grep for "verdict":"fail" — this exact
    // JSON would have passed under the old check purely because the string
    // appears, with no file/line verification at all.
    const { root } = makeFixtureProject();
    try {
      const log = `{"agent":"review-ranger","phase":"core","summary":{"filesReviewed":1,"findingsCount":1,"blockerCount":1,"majorCount":0,"minorCount":0},"findings":[{"severity":"blocker","category":"naming","file":"src/handler.ts","line":1,"description":"inconsistent naming convention"}],"verdict":"fail"}`;
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
