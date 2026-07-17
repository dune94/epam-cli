/**
 * topo_sort_stories: deprecated-parent resolution via specification.createdFrom
 *
 * Root cause (found live 2026-07-15, tier3-travel-app run): SKY-004 depends on
 * SKY-002. The spec pass split SKY-002 → [SKY-002-impl, SKY-002-test] and
 * marked SKY-002 as deprecated. `main_stories` filters out deprecated stories,
 * so SKY-002 is absent from the topo-sort id_set. The original code:
 *
 *   deps = [d for d in raw_deps if d in id_set]
 *
 * silently dropped SKY-004's SKY-002 dependency (not in id_set). SKY-004 became
 * an in-degree=0 root node and ran BEFORE SKY-002-impl — but server.ts imports
 * from ./skyscanner/client which SKY-002-impl hadn't built yet, and the scope
 * guard had that file locked read-only for SKY-004, so all 8 retries failed.
 *
 * Fix: build a split_children map from specification.createdFrom (already stored
 * on every split child by spec-mode-runner.js). When a dep is deprecated (not in
 * id_set), substitute its active children as the effective dependencies so the
 * topological ordering respects the transitive requirement.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractTopoSort(): string {
  const start = orchSrc.indexOf('topo_sort_stories() {');
  if (start === -1) throw new Error('topo_sort_stories() not found in run-agent-orchestration.sh');
  const end = orchSrc.indexOf('\n}', start) + 2;
  return orchSrc.slice(start, end);
}

function runTopoSort(storyIds: string[], prdStories: any[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'topo-sort-test-'));
  try {
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({ stories: prdStories }));
    const scriptPath = join(dir, 'run.sh');
    const topoFn = extractTopoSort();
    // Use a heredoc so the story list variable contains real newlines, not
    // escaped \n — topo_sort_stories does `echo "$story_list" | python3 ...`
    // which requires actual newline separators.
    writeFileSync(
      scriptPath,
      [
        `PRD_FILE=${JSON.stringify(prdPath)}`,
        topoFn,
        `_story_list=$(cat <<'TOPO_EOF'`,
        storyIds.join('\n'),
        'TOPO_EOF',
        ')',
        'topo_sort_stories "$_story_list"',
      ].join('\n'),
    );
    const out = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    return out.split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('topo_sort_stories — deprecated parent resolution', () => {
  it('REPRODUCES the live defect: without the fix, SKY-004 runs before its dependency children', () => {
    // This test documents what the OLD behavior was — if this ever starts failing
    // it means someone reverted the fix back to `if d in id_set` only.
    // With the fix applied, SKY-004 must come AFTER both SKY-002-impl and SKY-002-test.
    const result = runTopoSort(
      ['SKY-002-impl', 'SKY-002-test', 'SKY-003-A', 'SKY-003-B', 'SKY-004'],
      [
        { id: 'SKY-002', status: 'deprecated' },
        {
          id: 'SKY-002-impl',
          status: 'pending',
          dependencies: [],
          specification: { createdFrom: 'SKY-002' },
        },
        {
          id: 'SKY-002-test',
          status: 'pending',
          dependencies: ['SKY-002-impl'],
          specification: { createdFrom: 'SKY-002' },
        },
        {
          id: 'SKY-003-A',
          status: 'pending',
          dependencies: ['SKY-002'],
          specification: { createdFrom: 'SKY-003' },
        },
        {
          id: 'SKY-003-B',
          status: 'pending',
          dependencies: ['SKY-002', 'SKY-003-A'],
          specification: { createdFrom: 'SKY-003' },
        },
        { id: 'SKY-004', status: 'pending', dependencies: ['SKY-002'] },
      ],
    );
    const idx = (id: string) => result.indexOf(id);
    expect(idx('SKY-002-impl')).toBeGreaterThanOrEqual(0);
    expect(idx('SKY-002-test')).toBeGreaterThanOrEqual(0);
    expect(idx('SKY-004')).toBeGreaterThanOrEqual(0);
    // SKY-004 must come after both split children of SKY-002
    expect(idx('SKY-004')).toBeGreaterThan(idx('SKY-002-impl'));
    expect(idx('SKY-004')).toBeGreaterThan(idx('SKY-002-test'));
    // SKY-003-A must come after SKY-002 children (it also depends on SKY-002)
    expect(idx('SKY-003-A')).toBeGreaterThan(idx('SKY-002-impl'));
    expect(idx('SKY-003-A')).toBeGreaterThan(idx('SKY-002-test'));
    // SKY-003-B after SKY-003-A
    expect(idx('SKY-003-B')).toBeGreaterThan(idx('SKY-003-A'));
  });

  it('no deprecated parent — behaviour is unchanged (all deps in id_set)', () => {
    const result = runTopoSort(
      ['SKY-001', 'SKY-002', 'SKY-003'],
      [
        { id: 'SKY-001', status: 'pending', dependencies: [] },
        { id: 'SKY-002', status: 'pending', dependencies: ['SKY-001'] },
        { id: 'SKY-003', status: 'pending', dependencies: ['SKY-002'] },
      ],
    );
    expect(result).toEqual(['SKY-001', 'SKY-002', 'SKY-003']);
  });

  it('deprecated parent with all children already completed (not in id_set) — dependent story is a root node (deps already satisfied)', () => {
    // SKY-002-impl and SKY-002-test are completed so they are NOT in main_stories.
    // SKY-004 depends on the now-deprecated SKY-002 whose children are done.
    // The dep resolves to nothing active → SKY-004 runs as root (correct).
    const result = runTopoSort(
      ['SKY-004'],
      [
        { id: 'SKY-002', status: 'deprecated' },
        {
          id: 'SKY-002-impl',
          status: 'completed',
          completed: true,
          specification: { createdFrom: 'SKY-002' },
        },
        {
          id: 'SKY-002-test',
          status: 'completed',
          completed: true,
          specification: { createdFrom: 'SKY-002' },
        },
        { id: 'SKY-004', status: 'pending', dependencies: ['SKY-002'] },
      ],
    );
    expect(result).toEqual(['SKY-004']);
  });

  it('multi-level deprecation chain: SKY-004 depends on SKY-002, SKY-002 deprecated, only SKY-002-impl active (SKY-002-test not yet split into active set)', () => {
    const result = runTopoSort(
      ['SKY-002-impl', 'SKY-004'],
      [
        { id: 'SKY-002', status: 'deprecated' },
        {
          id: 'SKY-002-impl',
          status: 'pending',
          dependencies: [],
          specification: { createdFrom: 'SKY-002' },
        },
        { id: 'SKY-004', status: 'pending', dependencies: ['SKY-002'] },
      ],
    );
    expect(result.indexOf('SKY-004')).toBeGreaterThan(result.indexOf('SKY-002-impl'));
  });

  it('independent story with no dependencies is not reordered by deprecated-parent logic', () => {
    const result = runTopoSort(
      ['SKY-001', 'SKY-002-impl'],
      [
        { id: 'SKY-001', status: 'pending', dependencies: [] },
        {
          id: 'SKY-002-impl',
          status: 'pending',
          dependencies: [],
          specification: { createdFrom: 'SKY-002' },
        },
      ],
    );
    // Both are roots; declaration order preserved
    expect(result).toEqual(['SKY-001', 'SKY-002-impl']);
  });
});
