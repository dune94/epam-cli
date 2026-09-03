/**
 * Full agent audit re-audit, 2026-07-31: mutant-hunter's mutationScore and
 * survived-count were entirely self-reported with zero independent
 * verification — unlike review-ranger/perf-sentinel (now both codeSnippet-
 * verified against the real file) or fuzz-weaver (execution-verified). An
 * agent could report a low mutationScore that agreed with nothing real and
 * still block the pipeline.
 *
 * Fix: a "fail" verdict is only trusted when (1) summary.survived agrees
 * with the actual count of status:survived entries in the mutations array
 * (self-consistency — catches a score disconnected from its own detail),
 * AND (2) at least one survived mutation's `originalCode` is a literal
 * substring of the real file on disk (catches a fabricated file/line/code
 * claim — same "quote it, verify it" pattern as review-ranger/perf-sentinel).
 * This test extracts the REAL python verification block embedded in
 * run-agent-orchestration.sh and runs it against real fixture files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractMutantVerifyPython(): string {
  const anchor = orchSrc.indexOf('"agent".*"mutant-hunter"');
  expect(anchor, 'mutant-hunter grounding python block not found — source may have moved').toBeGreaterThan(-1);
  const start = orchSrc.lastIndexOf('import json, sys, re, os', anchor);
  expect(start).toBeGreaterThan(-1);
  const end = orchSrc.indexOf('\nMUTANT_PYEOF', anchor);
  expect(end).toBeGreaterThan(-1);
  return orchSrc.slice(start, end);
}

function makeFixtureProject(): { root: string; relPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'mutant-verify-fixture-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const relPath = 'src/discount.ts';
  writeFileSync(
    join(root, relPath),
    [
      'export function applyDiscount(price: number, isMember: boolean): number {',
      '  if (isMember) {',
      '    return price * 0.9;',
      '  }',
      '  return price;',
      '}',
    ].join('\n'),
  );
  return { root, relPath };
}

function runVerification(mutantLogJson: string, projectRoot: string): number {
  const dir = mkdtempSync(join(tmpdir(), 'mutant-verify-run-'));
  try {
    const logPath = join(dir, 'mutant-log.txt');
    writeFileSync(logPath, mutantLogJson);
    const scriptPath = join(dir, 'verify.py');
    writeFileSync(scriptPath, extractMutantVerifyPython());
    const output = execFileSync('python3', [scriptPath, logPath, projectRoot], { encoding: 'utf8', timeout: 15000 });
    return parseInt(output.trim(), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mutantLog(summary: Record<string, unknown>, mutations: unknown[]): string {
  return `preamble\n{"agent":"mutant-hunter","phase":"core","summary":${JSON.stringify(summary)},"mutations":${JSON.stringify(mutations)},"verdict":"fail"}\ntrailing`;
}

describe('mutant-hunter grounding — survived mutations must be real and self-consistent', () => {
  it('CONFIRMS a survived mutation whose originalCode is real, verbatim, and summary.survived agrees', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = mutantLog(
        { mutationsProposed: 1, killed: 0, survived: 1, noCoverage: 0, mutationScore: 0 },
        [
          {
            file: relPath,
            line: 3,
            originalCode: 'return price * 0.9;',
            mutatedCode: 'return price * 1.1;',
            status: 'survived',
            relatedTest: 'none',
          },
        ],
      );
      expect(runVerification(log, root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm when summary.survived disagrees with the actual survived count (self-inconsistent)', () => {
    // A REAL, well-grounded survived entry is present (would ground the
    // verdict on its own) — but summary.survived claims 2 while the
    // mutations array only lists 1 status:survived entry. This specifically
    // exercises the self-consistency check, not just "is there any grounded
    // entry" — a mutation of the self-consistency check alone (independent
    // of the originalCode-verification check) would flip this test's result.
    const { root, relPath } = makeFixtureProject();
    try {
      const log = mutantLog(
        { mutationsProposed: 2, killed: 0, survived: 2, noCoverage: 0, mutationScore: 0 },
        [
          { file: relPath, line: 3, originalCode: 'return price * 0.9;', mutatedCode: 'return price * 1.1;', status: 'survived' },
          // summary claims 2 survived; only 1 status:survived entry actually exists.
        ],
      );
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a survived mutation whose originalCode does not appear in the real file (hallucinated)', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = mutantLog(
        { mutationsProposed: 1, killed: 0, survived: 1, noCoverage: 0, mutationScore: 0 },
        [
          {
            file: relPath,
            line: 10,
            originalCode: 'return price * getLoyaltyMultiplier(tier);',
            mutatedCode: 'return price;',
            status: 'survived',
          },
        ],
      );
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a survived mutation with no originalCode at all', () => {
    const { root, relPath } = makeFixtureProject();
    try {
      const log = mutantLog(
        { mutationsProposed: 1, killed: 0, survived: 1, noCoverage: 0, mutationScore: 0 },
        [{ file: relPath, line: 3, status: 'survived' }],
      );
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('DOES NOT confirm a survived mutation pointing at a file that does not exist', () => {
    const { root } = makeFixtureProject();
    try {
      const log = mutantLog(
        { mutationsProposed: 1, killed: 0, survived: 1, noCoverage: 0, mutationScore: 0 },
        [{ file: 'src/does-not-exist.ts', line: 1, originalCode: 'anything', status: 'survived' }],
      );
      expect(runVerification(log, root)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
