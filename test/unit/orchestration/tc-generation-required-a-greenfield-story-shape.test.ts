// SIX VERIFICATION CRITERIA BECAME ZERO ASSERTIONS, AND THE SEAM REPORTED SUCCESS.
//
// Live metrolinx AMSD-2041, all three runs 2026-08-19. The story carried 6 verification criteria —
// the only real specification it had, since its single acceptance criterion was the Jira link
// placeholder "See in:". It finished with testCriteria: null, and the TC writer logged:
//
//     [tc-writer] No test stories need TCs in phase 'core' — skipping
//     [tc-writer] TC generation complete — test stories have testCriteria
//
// The qualification rule was:
//
//     is_test_story = any(_is_test_file(f) for f in files)
//     if is_test_story and not already_has_tc:
//
// A story qualifies ONLY if its own file list contains a test file — the greenfield shape, where
// the spec pass splits work into an implementation story plus a paired test story. A brownfield
// ticket arrives as ONE story with implementation files, so it can never qualify, and its VCs are
// never turned into anything executable.
//
// The cost is not theoretical. VC 3 and VC 4 say the page must render published content with no
// regression when no preview signal is active. Run 3 shipped `enable: true` unconditionally — the
// exact regression those criteria describe — because nothing had turned them into a test.
//
// TEST CRITERIA EXIST TO MAKE VERIFICATION CRITERIA EXECUTABLE. That is the qualification: a story
// with VCs and no TCs needs TCs, whatever shape its file list happens to have.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HANDLER = join(__dirname, '../../../orchestrations/scripts/lib/handlers/tc-stories-needing-criteria.py');
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

type Story = {
  id: string;
  files: string[];
  vcs?: string[];
  tcFacts?: string[];
  status?: string;
};

function prdWith(stories: Story[]): string {
  const d = mkdtempSync(join(tmpdir(), 'tc-need-')); made.push(d);
  const p = join(d, 'prd.json');
  writeFileSync(p, JSON.stringify({
    implementationOrder: { core: stories.map((s) => s.id) },
    stories: stories.map((s) => ({
      id: s.id,
      status: s.status,
      technicalNotes: { files: s.files },
      verificationCriteria: s.vcs ?? [],
      ...(s.tcFacts ? { testCriteria: { facts: s.tcFacts } } : {}),
    })),
  }, null, 2));
  return p;
}

function needing(prd: string, storyFilter = ''): string[] {
  const r = spawnSync('python3', [HANDLER, prd, 'core', storyFilter], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`handler exited ${r.status}: ${r.stderr}`);
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('a brownfield story — implementation files, no paired test story', () => {
  const story: Story = {
    id: 'TICKET-1',
    files: ['src/pages/_app.tsx', 'src/services/thing.ts'],
    vcs: ['Given a draft change, the page shows draft content', 'With no preview signal, no regression'],
  };

  it('needs test criteria — its VCs are otherwise never executable', () => {
    expect(needing(prdWith([story])),
      'a brownfield story can never qualify, so its verification criteria become nothing')
      .toContain('TICKET-1');
  });

  it('still needs them when addressed directly by --story', () => {
    expect(needing(prdWith([story]), 'TICKET-1')).toContain('TICKET-1');
  });
});

describe('what must NOT change', () => {
  it('a greenfield test story still qualifies', () => {
    expect(needing(prdWith([{ id: 'T-2', files: ['src/a.spec.ts'], vcs: ['x'] }]))).toContain('T-2');
  });

  it('a story that already has test criteria is left alone', () => {
    expect(needing(prdWith([{ id: 'T-3', files: ['src/a.spec.ts'], vcs: ['x'], tcFacts: ['a fact'] }])))
      .not.toContain('T-3');
  });

  it('a deprecated (split-away) parent is still skipped', () => {
    expect(needing(prdWith([{ id: 'T-4', files: ['src/a.spec.ts'], vcs: ['x'], status: 'deprecated' }])))
      .not.toContain('T-4');
  });

  it('a story with NO verification criteria is not dragged in', () => {
    // Nothing to make executable — TCs derive from VCs, so absent VCs mean absent TCs.
    expect(needing(prdWith([{ id: 'T-5', files: ['src/impl.ts'], vcs: [] }]))).not.toContain('T-5');
  });
});
