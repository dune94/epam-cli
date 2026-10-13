/**
 * HUMAN CHECKS DO NOT FAIL THE SPEC GATE — ONLY AN UNMET CRITERION DOES.
 *
 * AMSD-2974 run 9, resume 10 (2026-10-13): on the same story the spec validator rated the cxshared main line
 * 1 met / 4 partial / 6 untestable / 0 unmet and said "warn" (passed), and the 7.x back-port 2 met / 3 partial /
 * 6 untestable / 0 unmet and said "fail" — which halted the run. The untestable criteria were the screen-reader,
 * zoom, mobile-viewport and axe checks no automated test can show. lib/handlers/spec-extractor.py counted a story as
 * failing whenever its free-form verdict said "fail" and any criterion was not untestable. Operator, 2026-10-13:
 * "human checks should not pause the completion of the user story." The validator still judges every criterion; the
 * gate now fails a story if and only if the validator found a criterion UNMET. partial / untestable are follow-up.
 *
 * EXECUTED: the real spec-extractor.py on validator output shaped as the agent writes it (storyId, criteria with
 * status, per-story verdict, overallVerdict). The count it prints is what Step 22b fails on.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTRACTOR = join(__dirname, '../../../orchestrations/scripts/lib/handlers/spec-extractor.py');

function failing(stories: Array<{ statuses: string[]; verdict: string }>, overall: string) {
  const body = {
    agent: 'spec-validator', phase: 'core',
    stories: stories.map((s, i) => ({
      storyId: `S-${i + 1}`, title: 't',
      criteria: s.statuses.map((st, j) => ({ text: `criterion ${j + 1}`, status: st, evidence: 'e', gaps: 'g' })),
      overallCompliance: 35, verdict: s.verdict,
    })),
    overallVerdict: overall,
  };
  const f = join(mkdtempSync(join(tmpdir(), 'spec-gate-')), 'spec-validator-core.log');
  writeFileSync(f, `[spec-validator] output\n${JSON.stringify(body, null, 2)}\n`);
  return spawnSync('python3', [EXTRACTOR, f], { encoding: 'utf8' }).stdout.trim();
}

const RESUME10_7X = ['partial', 'partial', 'untestable', 'untestable', 'met', 'met', 'untestable', 'untestable', 'untestable', 'partial', 'untestable'];

describe('human checks do not fail the spec gate', () => {
  it('a "fail" verdict with NO unmet criterion (only partial / untestable / met) does not fail the story', () => {
    expect(failing([{ statuses: RESUME10_7X, verdict: 'fail' }], 'fail')).toBe('0');
  });

  it('NEGATIVE: a criterion the validator found UNMET fails the story', () => {
    expect(failing([{ statuses: [...RESUME10_7X, 'unmet'], verdict: 'fail' }], 'fail')).toBe('1');
  });

  it('an UNMET criterion fails the story even when the free-form verdict says warn', () => {
    expect(failing([{ statuses: ['met', 'unmet', 'untestable'], verdict: 'warn' }], 'warn')).toBe('1');
  });

  it('each story is judged on its own criteria — one unmet story among several counts once', () => {
    expect(failing([
      { statuses: ['met', 'partial'], verdict: 'fail' },
      { statuses: ['unmet', 'met'], verdict: 'fail' },
      { statuses: ['untestable'], verdict: 'fail' },
    ], 'fail')).toBe('1');
  });
});
