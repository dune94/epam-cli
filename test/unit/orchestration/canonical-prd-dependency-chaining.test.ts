/**
 * Root cause of a live-run defect (2026-07-03): the canonical PRD's
 * `agentGroup` (primary/independent worktree lane) is a static, hand-
 * authored field — never computed from `.dependencies`. SKY-002 and
 * SKY-004 happened to both be hand-assigned "primary" (coincidentally
 * chained correctly), but SKY-003 was assigned "independent" despite also
 * depending on SKY-002 (the Skyscanner client). Since `topo_sort_stories()`
 * only orders stories WITHIN a single lane's list, a cross-lane dependency
 * is invisible to it — SKY-003 started running in full parallel with
 * SKY-002, before SKY-002's file existed, reliably reproducing the
 * "wrong import path" / "file doesn't exist" failure class this session
 * spent significant effort diagnosing and fixing (contract injection,
 * relative-import-check) — neither of which can help when the dependency
 * genuinely hasn't been created yet.
 *
 * Fix: declare the real dependency (`dependencies: ["SKY-002"]`) on both
 * SKY-003 and SKY-004, and move SKY-003 into the "primary" agentGroup so
 * topo_sort_stories() places it after SKY-002 in the same sequential chain.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const PRD_PATH = join(REPO_ROOT, 'orchestrations/travel-app-prd.canonical.json');
const prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));

function storyById(id: string) {
  const s = prd.stories.find((story: any) => story.id === id);
  expect(s, `${id} not found in canonical PRD`).toBeTruthy();
  return s;
}

describe('canonical PRD — stories sharing a dependency are chained into the same agentGroup lane', () => {
  it('SKY-003 declares its real dependency on SKY-002 (the Skyscanner client)', () => {
    const sky003 = storyById('SKY-003');
    expect(sky003.dependencies).toContain('SKY-002');
  });

  it('SKY-004 declares its real dependency on SKY-002', () => {
    const sky004 = storyById('SKY-004');
    expect(sky004.dependencies).toContain('SKY-002');
  });

  it('SKY-003 is in the same agentGroup as SKY-002 (its dependency) — not a separate parallel lane', () => {
    const sky002 = storyById('SKY-002');
    const sky003 = storyById('SKY-003');
    expect(sky003.agentGroup).toBe(sky002.agentGroup);
  });

  it('SKY-004 is in the same agentGroup as SKY-002 (its dependency)', () => {
    const sky002 = storyById('SKY-002');
    const sky004 = storyById('SKY-004');
    expect(sky004.agentGroup).toBe(sky002.agentGroup);
  });

  it('structural guard: no story in the core phase is in a DIFFERENT agentGroup than a story it depends on', () => {
    // Generalizes the fix beyond SKY-002/003/004 specifically — catches this
    // class of bug for any future story added to the canonical PRD.
    const byId = new Map(prd.stories.map((s: any) => [s.id, s]));
    const violations: string[] = [];
    for (const story of prd.stories) {
      for (const depId of story.dependencies || []) {
        const dep = byId.get(depId);
        if (dep && dep.agentGroup !== story.agentGroup) {
          violations.push(`${story.id} (group=${story.agentGroup}) depends on ${depId} (group=${dep.agentGroup})`);
        }
      }
    }
    expect(violations, violations.join('; ')).toHaveLength(0);
  });
});
