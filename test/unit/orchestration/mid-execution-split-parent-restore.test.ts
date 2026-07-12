/**
 * validateMidExecutionSplits (spec-mode-runner.js) must restore a parent
 * story when a coherence-violation rejection leaves it with NO surviving
 * children — otherwise the parent's entire scope silently vanishes.
 *
 * Root cause this fixes (found live, 2026-07-10, tier3-travel-app run):
 * openspec (elaboration) and speckit (verification) each independently split
 * SKY-002 without knowing about each other, producing TWO redundant impl/test
 * pairs (SKY-002-impl/-test, then SKY-002-impl-1/-test-1) that both write to
 * client.ts/client.test.ts. validateMidExecutionSplits correctly detected the
 * cross-pair collision and deprecated all four children — but parentStory
 * (SKY-002) was ALREADY marked deprecated by applySpecChanges' spec-pass path
 * (which ran earlier, when the FIRST redundant split still looked valid in
 * isolation), and nothing ever restored it. Result: the Skyscanner API client
 * was never implemented at all this run — SKY-003 and SKY-004, which both
 * depend on it, failed on a missing module they could never actually import.
 *
 * Fix: when a coherence-violation rejection leaves a parent with no other
 * surviving (non-deprecated, non-split-rejected) children, resurrect it as a
 * single unsplit story — pending, not completed, ACs restored from the union
 * of the rejected children's ACs, re-added to implementationOrder if it fell
 * out.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// validateMidExecutionSplits calls process.exit(1) when hardViolations > 0 —
// by design (matches the live pipeline's own hard-abort behavior for a
// genuine coherence violation) — but it writes the PRD file FIRST, so the
// restoration this test verifies is already persisted to disk by the time
// exit is called. Stub it so a real coherence violation doesn't kill the
// test process, but the PRD write still lands.
vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as (code?: number) => never);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateMidExecutionSplits } = require(
  '../../../orchestrations/scripts/spec-mode-runner.js'
);

describe('validateMidExecutionSplits — parent restoration on coherence rejection (REAL execution)', () => {
  // resolvePromptExec resolves an AI provider unconditionally near the top of
  // validateMidExecutionSplits, even though the coherence-violation branch
  // under test here `continue`s before ever calling it -- set a dummy
  // provider so that resolution doesn't throw before reaching the code path
  // being tested.
  process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'qwen';
  process.env.PHASE = 'core';

  function buildPrd(dir: string) {
    const prdPath = join(dir, 'prd.json');
    const prd = {
      implementationOrder: {
        core: ['SKY-002-impl', 'SKY-002-test', 'SKY-002-impl-1', 'SKY-002-test-1', 'SKY-003-impl'],
      },
      stories: [
        {
          id: 'SKY-002',
          title: 'Skyscanner API client',
          status: 'deprecated', // already delegated once by applySpecChanges (spec-pass)
          completed: true,
          acceptanceCriteria: ['Delegated to split children: SKY-002-impl, SKY-002-test'],
          technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] },
        },
        {
          id: 'SKY-002-impl',
          title: 'Client core logic',
          status: 'pending',
          completed: false,
          agentRole: 'typescript-engineer',
          acceptanceCriteria: ['Client throws on missing API key'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] },
          specification: { createdFrom: 'SKY-002', splitDepth: 1 },
        },
        {
          id: 'SKY-002-test',
          title: 'Client tests',
          status: 'pending',
          completed: false,
          agentRole: 'test-engineer',
          acceptanceCriteria: ['Client tests cover happy path'],
          technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
          specification: { createdFrom: 'SKY-002', splitDepth: 1 },
        },
        {
          id: 'SKY-002-impl-1',
          title: 'Client mock mode',
          status: 'pending',
          completed: false,
          agentRole: 'typescript-engineer',
          acceptanceCriteria: ['Client supports a mock mode for offline testing'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] },
          specification: { createdFrom: 'SKY-002', splitDepth: 1 },
        },
        {
          id: 'SKY-002-test-1',
          title: 'Client mock mode tests',
          status: 'pending',
          completed: false,
          agentRole: 'test-engineer',
          acceptanceCriteria: ['Mock mode tests cover offline scenario'],
          technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
          specification: { createdFrom: 'SKY-002', splitDepth: 1 },
        },
        {
          id: 'SKY-003-impl',
          title: 'CLI entry point',
          status: 'pending',
          completed: false,
          acceptanceCriteria: ['CLI calls SkyscannerClient'],
          dependencies: ['SKY-002'],
        },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    return prdPath;
  }

  it('REPRODUCES the exact live defect and proves the fix: a parent with NO surviving children is restored as a single unsplit story', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mid-exec-split-restore-'));
    try {
      const prdPath = buildPrd(dir);
      await validateMidExecutionSplits(
        prdPath,
        'SKY-002-impl,SKY-002-test,SKY-002-impl-1,SKY-002-test-1'
      );
      const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      const parent = prd.stories.find((s: any) => s.id === 'SKY-002');
      const children = prd.stories.filter((s: any) => s.id.startsWith('SKY-002-'));

      // All four colliding children are rejected/deprecated.
      for (const child of children) {
        expect(child.status).toBe('deprecated');
      }

      // The fix: the parent is resurrected, not left permanently deprecated.
      expect(parent.status).toBe('pending');
      expect(parent.completed).toBe(false);
      // ACs restored from the union of the rejected children's ACs — the
      // original scope isn't lost.
      expect(parent.acceptanceCriteria).toEqual(
        expect.arrayContaining([
          'Client throws on missing API key',
          'Client tests cover happy path',
          'Client supports a mock mode for offline testing',
          'Mock mode tests cover offline scenario',
        ])
      );
      expect(parent.acceptanceCriteria).not.toContain('Delegated to split children: SKY-002-impl, SKY-002-test');
      // Re-added to implementationOrder so it actually gets implemented.
      expect(prd.implementationOrder.core).toContain('SKY-002');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT restore the parent if it already has a surviving (non-rejected) child from a different split attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mid-exec-split-no-restore-'));
    try {
      const prdPath = buildPrd(dir);
      let prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      // Give SKY-002 a THIRD child, from a different split attempt, that
      // doesn't collide with anything and should survive.
      prd.stories.push({
        id: 'SKY-002-docs',
        title: 'Client README',
        status: 'pending',
        completed: false,
        acceptanceCriteria: ['README documents the client API'],
        technicalNotes: { files: ['src/skyscanner/README.md'] },
        specification: { createdFrom: 'SKY-002', splitDepth: 1, speckitValidated: true },
      });
      prd.implementationOrder.core.push('SKY-002-docs');
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      await validateMidExecutionSplits(
        prdPath,
        'SKY-002-impl,SKY-002-test,SKY-002-impl-1,SKY-002-test-1'
      );
      prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      const parent = prd.stories.find((s: any) => s.id === 'SKY-002');
      // A surviving sibling exists (SKY-002-docs) -- the parent must stay
      // deprecated, since its scope is still represented by that child.
      expect(parent.status).toBe('deprecated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not restore a parent that was never deprecated in the first place (no-op safety)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mid-exec-split-not-deprecated-'));
    try {
      const prdPath = buildPrd(dir);
      let prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      const parentStory = prd.stories.find((s: any) => s.id === 'SKY-002');
      parentStory.status = 'pending'; // not deprecated for some other reason
      parentStory.completed = false;
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));

      await validateMidExecutionSplits(
        prdPath,
        'SKY-002-impl,SKY-002-test,SKY-002-impl-1,SKY-002-test-1'
      );
      prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      const parent = prd.stories.find((s: any) => s.id === 'SKY-002');
      expect(parent.status).toBe('pending');
      expect(parent.completed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
