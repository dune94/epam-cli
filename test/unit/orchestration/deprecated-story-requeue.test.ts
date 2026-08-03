/**
 * Deprecated stories must never be re-selected for implementation.
 *
 * Root cause this fixes (found live, 2026-07-10, tier3-travel-app run):
 * SKY-002-test was correctly rejected by the split-gate for a same-file
 * coherence violation (both SKY-002-test and SKY-002-test-1 wrote to
 * client.test.ts) and marked `status: "deprecated"`. Because it never ran,
 * it also has `completed: false`. The four story-categorization queries in
 * run-agent-orchestration.sh (main_stories, primary_stories,
 * independent_stories, review_stories, ~line 1512-1539) filtered only on
 * `.completed == false` and never checked `.status != "deprecated"` — so on
 * the NEXT orchestration loop restart (e.g. after an unrelated story like
 * SKY-004-test hard-failed and the loop re-ran), the deprecated story was
 * re-queued and actually re-implemented via claude.sh, burning real cost on
 * work that had already been correctly abandoned.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('run-agent-orchestration.sh — story categorization excludes deprecated stories (static)', () => {
  const idx = orchSrc.indexOf('# Categorize stories by agent group');
  const block = orchSrc.slice(idx, orchSrc.indexOf('review_stories=$(jq', idx) + 500);

  it('main_stories query excludes deprecated stories', () => {
    const mainIdx = block.indexOf('main_stories=$(jq');
    const mainBlock = block.slice(mainIdx, mainIdx + 400);
    expect(mainBlock).toMatch(/select\(\.status != "deprecated"\)/);
  });

  it('primary_stories query excludes deprecated stories', () => {
    const idx2 = block.indexOf('primary_stories=$(jq');
    const b = block.slice(idx2, idx2 + 400);
    expect(b).toMatch(/select\(\.status != "deprecated"\)/);
  });

  it('independent_stories query excludes deprecated stories', () => {
    const idx2 = block.indexOf('independent_stories=$(jq');
    const b = block.slice(idx2, idx2 + 400);
    expect(b).toMatch(/select\(\.status != "deprecated"\)/);
  });

  it('review_stories query excludes deprecated stories', () => {
    const idx2 = block.indexOf('review_stories=$(jq');
    const b = block.slice(idx2, idx2 + 400);
    expect(b).toMatch(/select\(\.status != "deprecated"\)/);
  });
});

describe('run-agent-orchestration.sh — REAL execution: reproduces the exact live bug and proves the fix', () => {
  function extractCategorizationBlock(): string {
    const idx = orchSrc.indexOf('# Categorize stories by agent group');
    const endIdx = orchSrc.indexOf(
      "select(.agentRole == \"review-agent\" and (.completed // false) == false) | .id' \"$PRD_FILE\")",
      idx
    );
    return orchSrc.slice(idx, endIdx + "select(.agentRole == \"review-agent\" and (.completed // false) == false) | .id' \"$PRD_FILE\")".length);
  }

  function categorize(phase: string, prdPath: string): Record<string, string[]> {
    const block = extractCategorizationBlock();
    const script = [
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `PHASE=${JSON.stringify(phase)}`,
      block,
      'echo "MAIN=[$main_stories]"',
      'echo "PRIMARY=[$primary_stories]"',
      'echo "INDEPENDENT=[$independent_stories]"',
      'echo "REVIEW=[$review_stories]"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    const parse = (label: string) => {
      const m = out.match(new RegExp(`${label}=\\[([\\s\\S]*?)\\]`));
      return m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean) : [];
    };
    return {
      main: parse('MAIN'),
      primary: parse('PRIMARY'),
      independent: parse('INDEPENDENT'),
      review: parse('REVIEW'),
    };
  }

  function setupPrd(phase: string) {
    const dir = mkdtempSync(join(tmpdir(), 'deprecated-requeue-'));
    const prdPath = join(dir, 'prd.json');
    const prd = {
      implementationOrder: {
        [phase]: ['SKY-002-test', 'SKY-002-test-1', 'SKY-LIVE-primary', 'SKY-LIVE-main', 'SKY-LIVE-indep', 'SKY-LIVE-review'],
      },
      stories: [
        {
          id: 'SKY-002-test',
          status: 'deprecated',
          completed: false,
          agentGroup: 'primary',
          technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
        },
        {
          id: 'SKY-002-test-1',
          status: 'pending',
          completed: false,
          agentGroup: 'primary',
          technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
        },
        { id: 'SKY-LIVE-primary', status: 'pending', completed: false, agentGroup: 'primary' },
        { id: 'SKY-LIVE-main', status: 'pending', completed: false, agentGroup: 'main' },
        { id: 'SKY-LIVE-indep', status: 'pending', completed: false, agentGroup: 'independent' },
        { id: 'SKY-LIVE-review', status: 'pending', completed: false, agentRole: 'review-agent' },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    return { dir, prdPath };
  }

  it('REPRODUCES the exact live defect and proves the fix: a deprecated primary story is never re-queued', () => {
    const phase = `test-phase-${Date.now()}`;
    const { dir, prdPath } = setupPrd(phase);
    try {
      const result = categorize(phase, prdPath);
      expect(result.primary).not.toContain('SKY-002-test');
      expect(result.primary).toContain('SKY-002-test-1');
      expect(result.primary).toContain('SKY-LIVE-primary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not regress the other three categories — live pending stories still selected', () => {
    const phase = `test-phase-${Date.now()}`;
    const { dir, prdPath } = setupPrd(phase);
    try {
      const result = categorize(phase, prdPath);
      expect(result.main).toContain('SKY-LIVE-main');
      expect(result.independent).toContain('SKY-LIVE-indep');
      expect(result.review).toContain('SKY-LIVE-review');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
