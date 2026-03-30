import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReportCommand } from '../../../src/cli/commands/report.js';
import type { SessionSummary } from '../../../src/context/SessionStore.js';

// Mock dependencies
vi.mock('../../../src/config/ConfigResolver.js', () => ({
  resolveConfig: vi.fn(),
}));

vi.mock('../../../src/context/SessionStore.js', () => ({
  listSessions: vi.fn(),
}));

// Import mocked modules after setting up mocks
import { resolveConfig } from '../../../src/config/ConfigResolver.js';
import { listSessions } from '../../../src/context/SessionStore.js';

function mockSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-123',
    model: 'claude-sonnet-4-6',
    totalInputTokens: 100000,
    totalOutputTokens: 10000,
    totalCost: 0.45,
    turnCount: 5,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    path: '/tmp/sessions/session-123.jsonl',
    ...overrides,
  };
}

describe('report command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    vi.mocked(resolveConfig).mockResolvedValue({
      projectRoot: '/tmp/project',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered with correct name and description', () => {
    const cmd = createReportCommand();
    expect(cmd.name()).toBe('report');
    expect(cmd.description()).toContain('burn-up report');
  });

  it('outputs markdown by default when sessions exist', async () => {
    const sessions = [
      mockSession({ model: 'claude-sonnet-4-6', totalCost: 1.5, turnCount: 10 }),
      mockSession({ model: 'gpt-4o', totalCost: 0.8, turnCount: 5 }),
    ];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');

    // Check for markdown report structure
    expect(output).toContain('Burn-up Report');
    expect(output).toContain('Summary');
    expect(output).toContain('Total Cost');
    expect(output).toContain('Sessions');
    expect(output).toContain('Cost by Model');
    expect(output).toContain('claude-sonnet-4-6');
    expect(output).toContain('gpt-4o');
  });

  it('outputs JSON when --format json is specified', async () => {
    const sessions = [
      mockSession({
        model: 'claude-sonnet-4-6',
        totalCost: 1.5,
        totalInputTokens: 100000,
        totalOutputTokens: 10000,
        turnCount: 10
      }),
    ];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--format', 'json']);

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = consoleLogSpy.mock.calls[0][0];

    // Should be valid JSON
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('totalCost');
    expect(parsed).toHaveProperty('totalCostFormatted');
    expect(parsed).toHaveProperty('sessionCount', 1);
    expect(parsed).toHaveProperty('totalTurns', 10);
    expect(parsed).toHaveProperty('costByModel');
    expect(parsed.costByModel).toHaveProperty('claude-sonnet-4-6');
  });

  it('handles empty state with no sessions (markdown)', async () => {
    vi.mocked(listSessions).mockResolvedValue([]);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test']);

    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls[0][0];
    expect(output).toContain('No sessions found');
  });

  it('handles empty state with no sessions (json)', async () => {
    vi.mocked(listSessions).mockResolvedValue([]);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--format', 'json']);

    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toContain('No sessions found');
  });

  it('filters sessions by client when --client is specified', async () => {
    const sessions = [
      mockSession({ id: 's1', client: 'acme-corp', totalCost: 1.0 }),
      mockSession({ id: 's2', client: 'other-client', totalCost: 2.0 }),
    ];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--client', 'acme-corp', '--format', 'json']);

    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    // Should only include acme-corp session
    expect(parsed.sessionCount).toBe(1);
    expect(parsed.totalCost).toBe(1.0);
  });

  it('shows appropriate message when client filter has no matches', async () => {
    const sessions = [mockSession({ client: 'other-client' })];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--client', 'nonexistent']);

    const output = consoleLogSpy.mock.calls[0][0];
    expect(output).toContain('No sessions found for client: nonexistent');
  });

  it('aggregates costs across multiple models correctly', async () => {
    const sessions = [
      mockSession({ model: 'claude-sonnet-4-6', totalCost: 1.5 }),
      mockSession({ model: 'claude-sonnet-4-6', totalCost: 0.5 }), // Same model
      mockSession({ model: 'gpt-4o', totalCost: 0.8 }),
    ];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--format', 'json']);

    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(parsed.totalCost).toBe(2.8);
    expect(parsed.sessionCount).toBe(3);
    expect(parsed.costByModel['claude-sonnet-4-6'].cost).toBe(2.0);
    expect(parsed.costByModel['gpt-4o'].cost).toBe(0.8);
  });

  it('handles errors gracefully', async () => {
    vi.mocked(resolveConfig).mockRejectedValue(new Error('Config error'));

    const cmd = createReportCommand();

    try {
      await cmd.parseAsync(['node', 'test']);
    } catch (err) {
      // process.exit was called
      expect(err).toEqual(new Error('process.exit called'));
    }

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorOutput = consoleErrorSpy.mock.calls[0][0];
    expect(errorOutput).toContain('Error generating report');
    expect(errorOutput).toContain('Config error');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('calculates average tokens per turn correctly', async () => {
    const sessions = [
      mockSession({
        totalInputTokens: 100000,
        totalOutputTokens: 50000,
        turnCount: 10
      }),
    ];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--format', 'json']);

    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    // (100000 + 50000) / 10 = 15000
    expect(parsed.averageTokensPerTurn).toBe(15000);
  });

  it('includes date range when sessions have dates', async () => {
    const sessions = [
      mockSession({
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-05')
      }),
      mockSession({
        createdAt: new Date('2025-12-25'),
        updatedAt: new Date('2026-01-10')
      }),
    ];
    vi.mocked(listSessions).mockResolvedValue(sessions);

    const cmd = createReportCommand();
    await cmd.parseAsync(['node', 'test', '--format', 'json']);

    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);

    expect(parsed.dateRange).toBeTruthy();
    expect(parsed.dateRange.earliest).toBe('2025-12-25T00:00:00.000Z');
    expect(parsed.dateRange.latest).toBe('2026-01-10T00:00:00.000Z');
  });
});
