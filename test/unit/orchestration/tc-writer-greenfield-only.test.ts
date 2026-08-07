/**
 * WHO OWNS TESTS FOR A BROWNFIELD STORY DEPENDS ON WHAT KIND OF STORY IT IS.
 *
 * Original decision, 2026-07-26: the TC writer is a greenfield mechanism. A brownfield
 * DEFECT is proven by a stronger one — a verification criterion states the observable
 * outcome, the repro-test-writer builds a test from it plus the real fix diff, and the
 * bug-reproduction gate EXECUTES that test against pre-fix and post-fix code. A test
 * criterion is a written intention; RED→GREEN is a demonstration.
 *
 * What that missed, found live on AMSD-2041 (2026-08-07): a brownfield story is not
 * always a defect. For a NOVEL brownfield story there is no bug to reproduce, so the
 * repro gate excludes it (story-guards.sh selects `.storyKind != "novel"`) — and Step 10
 * skipped ALL brownfield. Between them, no step owned tests. The reviewer asked for tests
 * on seven cycles across two runs, the writer had no test file in its manifest and a
 * minimal-fix instruction, and the phase halted every time. Two runs died in that loop.
 *
 * So the skip is narrowed: brownfield skips the TC writer only when every phase story is
 * a defect. One novel story and the TC writer runs.
 *
 * THIS FILE USED TO READ THE SCRIPT AS TEXT — readFileSync + toMatch on a message string.
 * It broke the moment that message was reworded, while proving nothing about behaviour: a
 * string match passes equally on a comment or a dead branch. The condition is now
 * EXECUTED, extracted verbatim from the real script, so these tests fail only when the
 * decision itself changes.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH_PATH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const ORCH = readFileSync(ORCH_PATH, 'utf8');

/**
 * Pull the REAL skip condition out of the script — not a copy of it. If the script stops
 * containing a recognisable Step 10 brownfield condition, every test here fails loudly
 * rather than silently passing against a stale copy.
 */
function skipCondition(): string {
  const line = ORCH.split('\n').find(
    l => /^if \[ "\$\{EPAM_BROWNFIELD:-0\}" = "1" \]/.test(l.trim()) && l.includes('_tc_novel_count'),
  );
  if (!line) throw new Error('Step 10 brownfield skip condition not found — the decision was removed or renamed');
  return line.trim().replace(/^if\s+/, '').replace(/;\s*then\s*$/, '');
}

/** Execute the extracted condition under a given state; returns the branch taken. */
function decide(env: { brownfield: string; novelCount: string }): 'SKIP' | 'RUN' {
  const script =
    `EPAM_BROWNFIELD=${JSON.stringify(env.brownfield)}\n` +
    `_tc_novel_count=${JSON.stringify(env.novelCount)}\n` +
    `if ${skipCondition()}; then echo SKIP; else echo RUN; fi\n`;
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = (res.stdout || '').trim();
  if (out !== 'SKIP' && out !== 'RUN') {
    throw new Error(`condition did not evaluate: stdout=${JSON.stringify(out)} stderr=${res.stderr}`);
  }
  return out;
}

describe('the harness is real', () => {
  it('the condition was found in the script and evaluates', () => {
    expect(skipCondition().length).toBeGreaterThan(20);
    expect(['SKIP', 'RUN']).toContain(decide({ brownfield: '1', novelCount: '0' }));
  });
});

describe('Step 10 — who owns tests', () => {
  it('brownfield with only defects SKIPS the TC writer', () => {
    expect(
      decide({ brownfield: '1', novelCount: '0' }),
      'defects are proven by the bug-reproduction gate; TCs would restate the VCs',
    ).toBe('SKIP');
  });

  it('THE DEADLOCK FIX: brownfield with a NOVEL story RUNS the TC writer', () => {
    expect(
      decide({ brownfield: '1', novelCount: '1' }),
      'a novel brownfield story is excluded from the repro gate too — with this skipped, ' +
      'NO step owns its tests and the writer/reviewer loop never terminates',
    ).toBe('RUN');
  });

  it('several novel stories also run it', () => {
    expect(decide({ brownfield: '1', novelCount: '3' })).toBe('RUN');
  });

  it('greenfield always runs it — there is no bug to reproduce', () => {
    expect(decide({ brownfield: '0', novelCount: '0' })).toBe('RUN');
    expect(decide({ brownfield: '', novelCount: '0' })).toBe('RUN');
  });
});

describe('the step still explains itself', () => {
  it('the skip states WHY, so it is distinguishable from a broken step', () => {
    // A silent skip is indistinguishable from a broken step — the failure mode this
    // pipeline has hit most often. Asserted on the emitted reason, not on its wording.
    // Anchor to the BROWNFIELD branch specifically — Step 10 has an earlier skip for
    // SKIP_TC_WRITER=1, and matching the first step_emit found that one instead.
    const idx = ORCH.indexOf('if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$_tc_novel_count" -eq 0 ]');
    expect(idx, 'the brownfield skip branch is gone').toBeGreaterThan(-1);
    const branch = ORCH.slice(idx, idx + 500);
    expect(branch).toMatch(/step_emit "10" "skip"/);
    expect(branch).toMatch(/bug-reproduction|verification criteria/i);
  });

  it('the brownfield check precedes the needs-TC check', () => {
    // Otherwise a brownfield run still pays for the query that decides whether TCs are
    // needed at all.
    const skipIdx = ORCH.indexOf('if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ "$_tc_novel_count" -eq 0 ]');
    const needIdx = ORCH.indexOf('elif [ "${_tc_writer_needed:-0}" -gt 0 ]');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(needIdx).toBeGreaterThan(skipIdx);
  });
});
