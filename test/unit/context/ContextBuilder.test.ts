import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPrompt } from '../../../src/context/ContextBuilder.js';
import type { Constraint } from '../../../src/constraints/types.js';
import * as ContextLoader from '../../../src/context/ContextLoader.js';

vi.mock('../../../src/context/ContextLoader.js', () => ({
  loadContextFile: vi.fn(),
}));

vi.mock('../../../src/decisions/DecisionStore.js', () => ({
  DecisionStore: vi.fn().mockImplementation(() => ({
    list: vi.fn().mockResolvedValue([]),
  })),
}));

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ContextLoader.loadContextFile).mockResolvedValue(null);
  });

  it('should prepend block constraints before the base system prompt', async () => {
    vi.mocked(ContextLoader.loadContextFile)
      .mockResolvedValueOnce('Custom base prompt')
      .mockResolvedValueOnce('Project context');

    const systemPrompt = await buildSystemPrompt({
      contextFilePath: '.epam/context.md',
      systemPromptFile: '.epam/system.md',
      blockConstraints: [
        {
          id: 'c1',
          rule: 'Do not bypass auth checks',
          severity: 'block',
          createdBy: 'admin',
          expiresAt: '2026-12-31T23:59:59Z',
        },
      ],
    });

    expect(systemPrompt.startsWith('[CONSTRAINTS — MUST FOLLOW]')).toBe(true);
    expect(systemPrompt.indexOf('[CONSTRAINTS — MUST FOLLOW]')).toBeLessThan(
      systemPrompt.indexOf('Custom base prompt')
    );
  });

  it('should inject block-severity constraints at the top', async () => {
    const blockConstraints: Constraint[] = [
      {
        id: 'c1',
        rule: 'Never use eval()',
        severity: 'block',
        createdBy: 'admin',
        expiresAt: '2026-12-31T23:59:59Z',
      },
      {
        id: 'c2',
        rule: 'Always validate input',
        severity: 'block',
        createdBy: 'admin',
        expiresAt: '2026-12-31T23:59:59Z',
      },
    ];

    const systemPrompt = await buildSystemPrompt({
      contextFilePath: '.epam/context.md',
      blockConstraints,
    });

    expect(systemPrompt).toContain('[CONSTRAINTS — MUST FOLLOW]');
    expect(systemPrompt).toContain('- Never use eval()');
    expect(systemPrompt).toContain('- Always validate input');

    // Block constraints should appear before project context
    const blockIndex = systemPrompt.indexOf('[CONSTRAINTS — MUST FOLLOW]');
    const contextIndex = systemPrompt.indexOf('## Project Context');
    expect(blockIndex).toBeLessThan(contextIndex === -1 ? systemPrompt.length : contextIndex);
  });

  it('should inject warn-severity constraints at the bottom', async () => {
    const warnConstraints: Constraint[] = [
      {
        id: 'c1',
        rule: 'Prefer const over let',
        severity: 'warn',
        createdBy: 'admin',
        expiresAt: '2026-12-31T23:59:59Z',
      },
    ];

    const systemPrompt = await buildSystemPrompt({
      contextFilePath: '.epam/context.md',
      warnConstraints,
    });

    expect(systemPrompt).toContain('[ADVISORY CONSTRAINTS]');
    expect(systemPrompt).toContain('- Prefer const over let');

    // Warn constraints should appear at the end
    const warnIndex = systemPrompt.indexOf('[ADVISORY CONSTRAINTS]');
    expect(warnIndex).toBeGreaterThan(0);
  });

  it('should inject both block and warn constraints in correct order', async () => {
    const blockConstraints: Constraint[] = [
      {
        id: 'c1',
        rule: 'Block rule',
        severity: 'block',
        createdBy: 'admin',
        expiresAt: '2026-12-31T23:59:59Z',
      },
    ];

    const warnConstraints: Constraint[] = [
      {
        id: 'c2',
        rule: 'Warn rule',
        severity: 'warn',
        createdBy: 'admin',
        expiresAt: '2026-12-31T23:59:59Z',
      },
    ];

    const systemPrompt = await buildSystemPrompt({
      contextFilePath: '.epam/context.md',
      blockConstraints,
      warnConstraints,
    });

    const blockIndex = systemPrompt.indexOf('[CONSTRAINTS — MUST FOLLOW]');
    const warnIndex = systemPrompt.indexOf('[ADVISORY CONSTRAINTS]');

    expect(blockIndex).toBeGreaterThan(-1);
    expect(warnIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeLessThan(warnIndex);
  });

  it('should not include constraint sections when no constraints provided', async () => {
    const systemPrompt = await buildSystemPrompt({
      contextFilePath: '.epam/context.md',
    });

    expect(systemPrompt).not.toContain('[CONSTRAINTS — MUST FOLLOW]');
    expect(systemPrompt).not.toContain('[ADVISORY CONSTRAINTS]');
  });

  it('should not include constraint sections when empty arrays provided', async () => {
    const systemPrompt = await buildSystemPrompt({
      contextFilePath: '.epam/context.md',
      blockConstraints: [],
      warnConstraints: [],
    });

    expect(systemPrompt).not.toContain('[CONSTRAINTS — MUST FOLLOW]');
    expect(systemPrompt).not.toContain('[ADVISORY CONSTRAINTS]');
  });
});
