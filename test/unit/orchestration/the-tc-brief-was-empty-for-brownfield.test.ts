// THE STORY QUALIFIED FOR TEST CRITERIA AND WAS THEN HANDED AN EMPTY BRIEF.
//
// Two handlers carried the SAME greenfield filter. Yesterday I fixed one:
//
//   tc-stories-needing-criteria.py   is_test_story = any(_is_test_file(f) for f in files)
//   tc-story-context.py:59-61        is_test_story = any(_is_test_file(f) for f in files)
//                                    if not is_test_story: continue
//
// So on 2026-08-20 the pipeline correctly decided the brownfield story NEEDED test criteria, then
// built its context from the second handler — which skipped it — and invoked the TC writer three
// times with nothing to work on. The agent said so itself, three times:
//
//   "I notice the 'Stories to process' section is empty — no story IDs, source files, or
//    verification criteria were provided."
//
// and the gate still reported "PASSED — all test stories have verified TCs". 14 occurrences of that
// empty brief across the runs, three wasted model calls in the last one alone.
//
// This is the failure my own note names: fix the CLASS, not the site. The scanner discipline I
// applied to jq_vals I did not apply here, inside the change meant to demonstrate it.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/lib/handlers/tc-story-context.py');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

type Story = { id: string; files: string[]; vcs?: string[]; acs?: string[] };

function fixture(stories: Story[]): { out: string; prd: string } {
  const d = mkdtempSync(join(tmpdir(), 'tc-ctx-')); made.push(d);
  const out = join(d, 'out'); mkdirSync(out, { recursive: true });
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    implementationOrder: { core: stories.map((s) => s.id) },
    stories: stories.map((s) => ({
      id: s.id,
      technicalNotes: { files: s.files },
      acceptanceCriteria: s.acs ?? [],
      verificationCriteria: s.vcs ?? [],
    })),
  }, null, 2));
  return { out, prd };
}

const context = (f: { out: string; prd: string }, story: string): string => {
  const r = spawnSync('python3', [HANDLER, f.out, f.prd, 'core', story], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`handler exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};

describe('a brownfield story — implementation files, no paired test story', () => {
  const story: Story = {
    id: 'TICKET-1',
    files: ['src/pages/_app.tsx', 'src/services/thing.ts'],
    vcs: ['Given a draft change, the page shows draft content',
          'With no preview signal, published content renders unchanged'],
  };

  it('gets a brief at all', () => {
    expect(context(fixture([story]), 'TICKET-1').trim(),
      'the TC writer is invoked with nothing and cannot produce criteria').not.toBe('');
  });

  it('the brief names the story', () => {
    expect(context(fixture([story]), 'TICKET-1')).toMatch(/TICKET-1/);
  });

  it('the brief carries the implementation files to read', () => {
    const c = context(fixture([story]), 'TICKET-1');
    expect(c).toMatch(/IMPL_SOURCE_FILES/);
    expect(c).toMatch(/_app\.tsx/);
  });

  it('the brief carries the verification criteria — the source the prompt derives from', () => {
    const c = context(fixture([story]), 'TICKET-1');
    expect(c).toMatch(/VERIFICATION_CRITERIA/);
    expect(c).toMatch(/published content renders unchanged/);
  });
});

describe('what must not change', () => {
  it('a greenfield test story still gets its brief', () => {
    const f = fixture([{ id: 'T-2', files: ['src/a.ts', 'src/a.spec.ts'], vcs: ['x'] }]);
    expect(context(f, 'T-2')).toMatch(/T-2/);
  });

  it('a story with no verification criteria is not given a brief', () => {
    // Nothing to make executable. Deriving criteria from the implementation alone is how a test
    // comes to ratify whatever was built.
    const f = fixture([{ id: 'T-3', files: ['src/impl.ts'], vcs: [] }]);
    expect(context(f, 'T-3').trim()).toBe('');
  });
});

describe('the two handlers agree', () => {
  // The defect was that one said "needs TCs" and the other said "not a story I build context for".
  // Whatever qualifies must be briefable, or the pipeline pays for an agent call that cannot work.
  const NEEDING = join(ROOT, 'orchestrations/scripts/lib/handlers/tc-stories-needing-criteria.py');

  it('every story that NEEDS criteria can be given a brief', () => {
    const f = fixture([
      { id: 'BROWN-1', files: ['src/impl.ts'], vcs: ['observable thing'] },
      { id: 'GREEN-1', files: ['src/b.ts', 'src/b.spec.ts'], vcs: ['another'] },
      { id: 'NOVC-1', files: ['src/c.ts'], vcs: [] },
    ]);
    const needing = spawnSync('python3', [NEEDING, f.prd, 'core', ''], { encoding: 'utf8' })
      .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(needing.length, 'nothing qualified, so this proves nothing').toBeGreaterThan(0);
    for (const sid of needing) {
      expect(context(f, sid).trim(), `${sid} needs TCs but gets an empty brief`).not.toBe('');
    }
  });
});
