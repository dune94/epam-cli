/**
 * NOVEL BROWNFIELD WORK HAD NO TEST MECHANISM AT ALL.
 *
 * Two gates were supposed to cover testing, and each assumed the other did it:
 *
 *   Step 3.55  bug-reproduction gate — phase_stories_for_repro_gate EXCLUDES storyKind
 *              "novel". Correct: a new capability has no prior bug, so RED→GREEN against a
 *              pre-fix baseline is unsatisfiable.
 *   Step 10    TC writer gate — skipped for ALL brownfield, on the stated grounds that
 *              "the bug-reproduction gate" proves the change instead.
 *
 * For a novel brownfield story that is a hand-off to nobody. Live 2026-08-07, AMSD-2041
 * (storyKind: novel): Step 10 skipped, Step 3.55 reported "passed for all phase stories"
 * because it had none to check, and no step in the pipeline owned tests.
 *
 * The consequence was a deadlock that cost two full writer runs. The team-lead reviewer asked
 * for tests on SEVEN review cycles; the writer, under a minimal-fix instruction with no test
 * file in its manifest, never wrote any; the reviewer never approved; the phase halted with
 * "a change the reviewer never approved must NOT proceed". Every symptom looked like a guard
 * working correctly, which is why it survived so long.
 *
 * The split is now explicit: defects are proven by REPRODUCTION, novel work by TEST CRITERIA.
 * The two selectors are exact complements over storyKind.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const GUARDS = join(ROOT, 'orchestrations/scripts/lib/story-guards.sh');
const ORCH = readFileSync(join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function prdWith(stories: Array<{ id: string; storyKind?: string }>): string {
  const d = mkdtempSync(join(tmpdir(), 'tcsplit-')); dirs.push(d);
  const f = join(d, 'prd.json');
  writeFileSync(f, JSON.stringify({
    implementationOrder: { core: stories.map((s) => s.id) },
    stories: stories.map((s) => ({ id: s.id, ...(s.storyKind ? { storyKind: s.storyKind } : {}) })),
  }));
  return f;
}

function select(fn: 'phase_stories_for_tc_writer' | 'phase_stories_for_repro_gate', prd: string): string[] {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(GUARDS)}; ${fn} ${JSON.stringify(prd)} core`], { encoding: 'utf8' });
  expect(r.status, `selector failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim().split('\n').filter(Boolean);
}

describe('the two gates are exact complements over storyKind', () => {
  const prd = () => prdWith([
    { id: 'NOVEL-1', storyKind: 'novel' },
    { id: 'DEFECT-1', storyKind: 'defect' },
    { id: 'UNCLASSIFIED-1' },
  ]);

  it('THE HOLE: a novel story is selected for test criteria', () => {
    expect(
      select('phase_stories_for_tc_writer', prd()),
      'novel brownfield work had neither a reproduction gate nor a test writer',
    ).toContain('NOVEL-1');
  });

  it('a defect is NOT sent to the TC writer — reproduction proves it', () => {
    expect(select('phase_stories_for_tc_writer', prd())).not.toContain('DEFECT-1');
  });

  it('a defect IS sent to the reproduction gate', () => {
    expect(select('phase_stories_for_repro_gate', prd())).toContain('DEFECT-1');
  });

  it('a novel story is NOT sent to the reproduction gate — nothing to reproduce', () => {
    expect(select('phase_stories_for_repro_gate', prd())).not.toContain('NOVEL-1');
  });

  it('NOTHING FALLS BETWEEN THEM: every story lands in exactly one gate', () => {
    const p = prd();
    const tc = select('phase_stories_for_tc_writer', p);
    const repro = select('phase_stories_for_repro_gate', p);
    for (const id of ['NOVEL-1', 'DEFECT-1', 'UNCLASSIFIED-1']) {
      const inTc = tc.includes(id), inRepro = repro.includes(id);
      expect(inTc || inRepro, `${id} is covered by neither gate — the defect this fixes`).toBe(true);
      expect(inTc && inRepro, `${id} is in both gates — duplicate, overlapping requirements`).toBe(false);
    }
  });

  it('an unclassified story stays on the safe side, as the repro gate already required', () => {
    expect(select('phase_stories_for_repro_gate', prd())).toContain('UNCLASSIFIED-1');
  });

  it('a phase with only defects selects nothing for the TC writer', () => {
    expect(select('phase_stories_for_tc_writer', prdWith([{ id: 'D-1', storyKind: 'defect' }]))).toEqual([]);
  });
});

describe('Step 10 consults the selector instead of skipping all brownfield', () => {
  it('the blanket brownfield skip is gone', () => {
    expect(
      ORCH,
      'brownfield skipped the TC writer unconditionally, which left novel work with no test mechanism',
    ).not.toMatch(/if \[ "\$\{EPAM_BROWNFIELD:-0\}" = "1" \]; then\s*\n\s*step_emit "10" "skip"/);
  });

  it('it skips only when every phase story is a defect', () => {
    expect(ORCH).toMatch(/phase_stories_for_tc_writer/);
    expect(ORCH).toMatch(/_tc_novel_count" -eq 0/);
    expect(ORCH, 'the skip message should say WHY it is safe to skip').toMatch(/every phase story is a defect/);
  });
});
