import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConsultationBlock,
  consumeConsultationContext,
  loadPendingConsultation,
  queueConsultationForNextTurn,
} from '../../../src/context/ContextBuilder.js';
import type { ConsultationContext } from '../../../src/context/ContextBuilder.js';

describe('consultation context', () => {
  const tempRoots: string[] = [];

  async function createProjectRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epam-consultation-'));
    await fs.mkdir(path.join(root, '.epam'), { recursive: true });
    tempRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  function createConsultation(): ConsultationContext {
    return {
      profileName: 'security-architect',
      systemPromptAppend: 'Focus on security invariants.',
      decisions: [
        {
          id: 'dec-1',
          title: 'Use parameterized queries',
          description: 'Avoid SQL injection',
          rationale: 'Raw string concatenation is unsafe',
          pattern_to_avoid: 'Building SQL with template strings',
          approved_alternative: 'Prepared statements',
          tags: ['security'],
          createdAt: '2026-03-01T00:00:00Z',
        },
      ],
    };
  }

  it('builds the consultation block with profile and matching decisions', () => {
    const block = buildConsultationBlock(createConsultation());

    expect(block).toContain('[CONSULTING: @security-architect]');
    expect(block).toContain('Focus on security invariants.');
    expect(block).toContain('[RECENT MATCHING DECISIONS]');
    expect(block).toContain('Decision dec-1: Use parameterized queries');
  });

  it('applies consultation context only once', async () => {
    const projectRoot = await createProjectRoot();
    await queueConsultationForNextTurn(createConsultation(), projectRoot);

    const first = await consumeConsultationContext('Review this patch.', projectRoot);
    const second = await consumeConsultationContext('Review this patch.', projectRoot);

    expect(first).toContain('[CONSULTING: @security-architect]');
    expect(first).toContain('Review this patch.');
    expect(second).toBe('Review this patch.');
  });

  it('loads queued consultation state from disk without mutating it', async () => {
    const projectRoot = await createProjectRoot();
    await queueConsultationForNextTurn(createConsultation(), projectRoot);

    const loaded = await loadPendingConsultation(projectRoot);
    expect(loaded?.profileName).toBe('security-architect');

    loaded?.decisions.push({
      id: 'dec-2',
      title: 'Mutated',
      rationale: 'test',
      pattern_to_avoid: 'test',
      approved_alternative: 'test',
      tags: [],
      createdAt: '2026-03-01T00:00:00Z',
    });

    const loadedAgain = await loadPendingConsultation(projectRoot);
    expect(loadedAgain?.decisions).toHaveLength(1);
  });
});
