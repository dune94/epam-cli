/**
 * Step 1 (main-branch stories) must refresh `main_stories` against the
 * CURRENT PRD before running, not just trust the phase-start snapshot.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app run):
 * `main_stories` is computed ONCE at phase start (~line 1670 in
 * run-agent-orchestration.sh), before Step 0.5's mid-execution-split
 * validation (validate_mid_execution_splits) runs. That validation can
 * legitimately RESTORE a parent story that was already deprecated-via-split
 * at snapshot time (SKY-001's 4 split children collided on a coherence
 * violation and were deprecated; SKY-001 itself was correctly resurrected to
 * `pending` — see mid-execution-split-parent-restore.test.ts). But the
 * stale `main_stories` snapshot, captured BEFORE any of that happened, never
 * contained SKY-001 to begin with (it wasn't pending yet — it had already
 * been split away). Step 1's loop then only iterated the snapshot's 4 (now
 * deprecated) split children, skipped all of them via the existing live
 * status re-check, and declared "Main-branch stories complete" having run
 * NOTHING — the scaffold phase's whole deliverable (package.json,
 * tsconfig.json, etc.) was silently never produced.
 *
 * Fix: right before Step 1 begins, re-query the PRD for anything currently
 * pending (completed=false, not deprecated, not review-agent) that ISN'T
 * already tracked in main_stories/primary_stories/independent_stories, and
 * append it — then re-run topo_sort_stories. This only ever ADDS a story
 * back in; it never removes anything (removal is handled separately by the
 * existing live deprecated-status check inside the loop itself).
 *
 * EXTENDED (same day, second live occurrence): a restored parent can carry
 * agentGroup=primary or independent (its pre-split group) — the first
 * version of this fix only refreshed main/preflight, so SKY-002/SKY-003
 * (agentGroup=primary) fell into a complete gap when topology had already
 * collapsed the primary lane into main_stories BEFORE the restoration
 * happened (Step 2/worktree creation had already decided "no parallel
 * stories" from the stale pre-restoration snapshot and never reconsiders).
 * Fix now routes each newly-eligible story to whichever lane is STILL doing
 * work for its own agentGroup (primary_stories/independent_stories, if
 * non-empty — Step 2 hasn't run yet at this point and will see the update),
 * falling back to main_stories when that lane is empty (already collapsed,
 * or never had work) since main_stories is the only lane guaranteed to
 * still process further pending work this phase.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractByLineAnchor(startMarker: string, endMarker: string): string {
  const lines = orchSrc.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(startMarker));
  if (startIdx === -1) throw new Error(`Could not find start marker: ${startMarker}`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes(endMarker));
  if (endIdx === -1) throw new Error(`Could not find end marker: ${endMarker}`);
  return lines.slice(startIdx, endIdx).join('\n');
}

describe('Step 1 main_stories refresh — wiring (static)', () => {
  it('the refresh block runs AFTER validate_mid_execution_splits and BEFORE the Step 1 loop begins', () => {
    const splitIdx = orchSrc.indexOf('validate_mid_execution_splits "$PHASE"');
    const refreshIdx = orchSrc.indexOf('_main_stories_current=$(jq -r --arg phase "$PHASE"');
    const loopIdx = orchSrc.indexOf('while IFS= read -r story; do');
    expect(splitIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(splitIdx);
    expect(loopIdx).toBeGreaterThan(refreshIdx);
  });

  it('the refresh query covers all four non-review agentGroups (main/preflight/primary/independent), not deprecated, not completed', () => {
    const idx = orchSrc.indexOf('_main_stories_current=$(jq -r --arg phase "$PHASE"');
    const block = orchSrc.slice(idx, idx + 500);
    expect(block).toMatch(/select\(\.status != "deprecated"\)/);
    expect(block).toMatch(/\.completed == false/);
    expect(block).toMatch(/agentRole != "review-agent"/);
    expect(block).toMatch(/\$g == "main" or \$g == "preflight" or \$g == "primary" or \$g == "independent"/);
  });

  it('routes a newly-eligible story to whichever lane is still active for its agentGroup, falling back to main when that lane is empty', () => {
    const idx = orchSrc.indexOf('_main_stories_current=$(jq -r --arg phase "$PHASE"');
    const block = orchSrc.slice(idx, idx + 1800);
    expect(block).toMatch(/case "\$_rgroup" in/);
    expect(block).toMatch(/primary\)\s+\[ -n "\$primary_stories" \] && _dest="primary"/);
    expect(block).toMatch(/independent\)\s+\[ -n "\$independent_stories" \] && _dest="independent"/);
  });
});

describe('Step 1 main_stories refresh — REAL execution', () => {
  function extractRefreshBlock(): string {
    return extractByLineAnchor(
      '# Root cause fix (found live, 2026-07-11, tier3-travel-app run): main_stories',
      'if [ -n "$main_stories" ]; then',
    );
  }

  function extractTopoSort(): string {
    const start = orchSrc.indexOf('topo_sort_stories() {');
    const end = orchSrc.indexOf('\n}', start) + 2;
    return orchSrc.slice(start, end);
  }

  function run(opts: {
    mainStoriesSnapshot: string;
    primaryStoriesSnapshot?: string;
    independentStoriesSnapshot?: string;
    prdStories: any[];
    phase?: string;
  }): {
    finalMainStories: string[];
    finalPrimaryStories: string[];
    finalIndependentStories: string[];
  } {
    const dir = mkdtempSync(join(tmpdir(), 'main-stories-refresh-'));
    try {
      const prdPath = join(dir, 'prd.json');
      const phase = opts.phase ?? 'scaffold';
      writeFileSync(
        prdPath,
        JSON.stringify({
          implementationOrder: { [phase]: opts.prdStories.map((s) => s.id) },
          stories: opts.prdStories,
        }),
      );
      const refreshBlock = extractRefreshBlock();
      const topoSort = extractTopoSort();
      const scriptPath = join(dir, 'run.sh');
      const heredoc = (name: string, content: string) =>
        [`${name}=$(cat <<'MS_EOF'`, content, 'MS_EOF', ')'].join('\n');
      writeFileSync(
        scriptPath,
        [
          'warning() { echo "$*" >&2; }',
          `PRD_FILE=${JSON.stringify(prdPath)}`,
          `PHASE=${JSON.stringify(phase)}`,
          heredoc('main_stories', opts.mainStoriesSnapshot),
          heredoc('primary_stories', opts.primaryStoriesSnapshot ?? ''),
          heredoc('independent_stories', opts.independentStoriesSnapshot ?? ''),
          topoSort,
          refreshBlock,
          'echo "===MAIN==="',
          'echo "$main_stories"',
          'echo "===PRIMARY==="',
          'echo "$primary_stories"',
          'echo "===INDEPENDENT==="',
          'echo "$independent_stories"',
        ].join('\n'),
      );
      const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const [, mainPart, primaryPart, independentPart] = stdout.split(/===MAIN===|===PRIMARY===|===INDEPENDENT===/);
      const toList = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
      return {
        finalMainStories: toList(mainPart ?? ''),
        finalPrimaryStories: toList(primaryPart ?? ''),
        finalIndependentStories: toList(independentPart ?? ''),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: a story restored to pending AFTER the stale snapshot was taken gets added back into main_stories', () => {
    // Snapshot only ever saw the (now-deprecated) split children — SKY-001
    // itself was NOT pending yet when the snapshot was taken.
    const { finalMainStories } = run({
      mainStoriesSnapshot: 'SKY-001-impl\nSKY-001-test\nSKY-001-impl-1\nSKY-001-test-1',
      prdStories: [
        { id: 'SKY-001', status: 'pending', completed: false, agentGroup: 'main' }, // restored
        { id: 'SKY-001-impl', status: 'deprecated', completed: false, agentGroup: 'main' },
        { id: 'SKY-001-test', status: 'deprecated', completed: false, agentGroup: 'main' },
        { id: 'SKY-001-impl-1', status: 'deprecated', completed: false, agentGroup: 'main' },
        { id: 'SKY-001-test-1', status: 'deprecated', completed: false, agentGroup: 'main' },
      ],
    });
    expect(finalMainStories).toContain('SKY-001');
  });

  it('does NOT duplicate a story that was already correctly in the snapshot', () => {
    const { finalMainStories } = run({
      mainStoriesSnapshot: 'SKY-002',
      prdStories: [{ id: 'SKY-002', status: 'pending', completed: false, agentGroup: 'main' }],
    });
    const occurrences = finalMainStories.filter((s) => s === 'SKY-002').length;
    expect(occurrences).toBe(1);
  });

  it('never adds a review-agent story regardless of agentGroup (review stories run separately in Step 4)', () => {
    const { finalMainStories, finalPrimaryStories, finalIndependentStories } = run({
      mainStoriesSnapshot: '',
      prdStories: [{ id: 'SKY-004', status: 'pending', completed: false, agentRole: 'review-agent', agentGroup: undefined }],
    });
    expect(finalMainStories).not.toContain('SKY-004');
    expect(finalPrimaryStories).not.toContain('SKY-004');
    expect(finalIndependentStories).not.toContain('SKY-004');
  });

  it('REPRODUCES the SECOND live defect and proves the extended fix: a restored agentGroup=primary story falls back to main_stories when the primary lane was already collapsed to empty (topology=sequential)', () => {
    const { finalMainStories, finalPrimaryStories } = run({
      mainStoriesSnapshot: 'SKY-004-impl',
      primaryStoriesSnapshot: '', // collapsed by topology before restoration happened
      prdStories: [
        { id: 'SKY-002', status: 'pending', completed: false, agentGroup: 'primary' }, // restored parent
        { id: 'SKY-004-impl', status: 'pending', completed: false, agentGroup: 'main' },
      ],
    });
    expect(finalMainStories).toContain('SKY-002');
    expect(finalPrimaryStories).not.toContain('SKY-002');
  });

  it('routes a restored agentGroup=primary story into primary_stories (not main_stories) when the primary lane is still active (topology=parallel, genuine worktree work pending)', () => {
    const { finalMainStories, finalPrimaryStories } = run({
      mainStoriesSnapshot: '',
      primaryStoriesSnapshot: 'SKY-999-other-primary-story',
      prdStories: [
        { id: 'SKY-002', status: 'pending', completed: false, agentGroup: 'primary' }, // restored parent
        { id: 'SKY-999-other-primary-story', status: 'pending', completed: false, agentGroup: 'primary' },
      ],
    });
    expect(finalPrimaryStories).toContain('SKY-002');
    expect(finalMainStories).not.toContain('SKY-002');
  });

  it('routes a restored agentGroup=independent story the same way (falls back to main when independent lane is empty)', () => {
    const { finalMainStories, finalIndependentStories } = run({
      mainStoriesSnapshot: '',
      independentStoriesSnapshot: '',
      prdStories: [{ id: 'SKY-005', status: 'pending', completed: false, agentGroup: 'independent' }],
    });
    expect(finalMainStories).toContain('SKY-005');
    expect(finalIndependentStories).not.toContain('SKY-005');
  });

  it('does NOT add back a story that is genuinely deprecated (no restoration happened)', () => {
    const { finalMainStories } = run({
      mainStoriesSnapshot: '',
      prdStories: [{ id: 'SKY-005', status: 'deprecated', completed: false, agentGroup: 'main' }],
    });
    expect(finalMainStories).not.toContain('SKY-005');
  });

  it('is a no-op when nothing changed since the snapshot (common case — most phases never hit a split collision)', () => {
    const { finalMainStories } = run({
      mainStoriesSnapshot: 'SKY-006\nSKY-007',
      prdStories: [
        { id: 'SKY-006', status: 'pending', completed: false, agentGroup: 'main' },
        { id: 'SKY-007', status: 'pending', completed: false, agentGroup: 'preflight' },
      ],
    });
    expect(finalMainStories.sort()).toEqual(['SKY-006', 'SKY-007']);
  });
});
