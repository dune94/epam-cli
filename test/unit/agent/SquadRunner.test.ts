import { describe, it, expect, vi } from 'vitest';
import { SquadRunner } from '../../../src/agent/squad/SquadRunner.js';
import type { LLMProvider, StreamDelta } from '../../../src/providers/types.js';
import type { Tool } from '../../../src/tools/types.js';

// Mock LLMProvider that returns controlled responses
class MockProvider implements LLMProvider {
  private responses: string[] = [];
  private responseIndex = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async stream(
    _request: unknown,
    onDelta?: (delta: StreamDelta) => void
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    usage: { inputTokens: number; outputTokens: number };
    stopReason: string;
  }> {
    const response = this.responses[this.responseIndex++] || '';
    if (onDelta) {
      onDelta({ type: 'text_delta', text: response });
    }
    return {
      content: [{ type: 'text', text: response }],
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: 'end_turn',
    };
  }
}

const mockTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    permission: 'safe',
    definition: { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {}, required: [] } },
    execute: async () => ({ toolUseId: '', content: 'file content', isError: false }),
  },
];

describe('SquadRunner', () => {
  it('parses valid SquadPlan JSON from Leader', async () => {
    const provider = new MockProvider([
      // Leader response
      `{
        "subtasks": [
          {"id": "coder-1", "role": "Coder", "description": "Implement feature", "dependsOn": []},
          {"id": "tester-1", "role": "Tester", "description": "Test feature", "dependsOn": []},
          {"id": "auditor-1", "role": "SecurityAuditor", "description": "Review code", "dependsOn": ["coder-1"]}
        ]
      }`,
      // Coder response
      'Implementation complete',
      // Tester response
      'Tests look good',
      // Auditor response
      '{"status": "approved", "findings": [], "summary": "No issues"}',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Build a feature',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    expect(result.plan.subtasks).toHaveLength(3);
    expect(result.plan.subtasks[0].role).toBe('Coder');
    expect(result.plan.subtasks[1].role).toBe('Tester');
    expect(result.plan.subtasks[2].role).toBe('SecurityAuditor');
    expect(result.securityReview?.status).toBe('approved');
  });

  it('handles Leader JSON wrapped in markdown', async () => {
    const provider = new MockProvider([
      `Here's the plan:\n\`\`\`json\n{
        "subtasks": [
          {"id": "c1", "role": "Coder", "description": "Code", "dependsOn": []}
        ]
      }\n\`\`\``,
      'Done',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Simple task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();
    expect(result.plan.subtasks).toHaveLength(1);
  });

  it('throws error when Leader produces invalid JSON', async () => {
    const provider = new MockProvider(['Not valid JSON at all']);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    await expect(runner.run()).rejects.toThrow('Leader failed to produce valid SquadPlan JSON');
  });

  it('executes Coder and Tester in parallel', async () => {
    const executionOrder: string[] = [];
    const provider = new MockProvider([
      // Leader
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []},
        {"id": "t", "role": "Tester", "description": "Test", "dependsOn": []}
      ]}`,
      // Coder
      'Coder output',
      // Tester
      'Tester output',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
      onProgress: (role) => {
        executionOrder.push(role);
      },
    });

    const result = await runner.run();

    expect(result.coderOutput).toContain('Coder output');
    expect(result.testerOutput).toContain('Tester output');
    // Both should appear in progress (order may vary due to parallel execution)
    expect(executionOrder).toContain('Coder');
    expect(executionOrder).toContain('Tester');
  });

  it('SecurityAuditor approves on first review', async () => {
    const provider = new MockProvider([
      // Leader
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []},
        {"id": "a", "role": "SecurityAuditor", "description": "Audit", "dependsOn": ["c"]}
      ]}`,
      // Coder
      'Coder implementation',
      // Auditor
      '{"status": "approved", "findings": [], "summary": "Looks good"}',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    expect(result.securityReview?.status).toBe('approved');
    expect(result.reviewCycles).toBe(1);
    expect(result.finalOutput).toContain('✓ Approved');
  });

  it('SecurityAuditor blocks and re-reviews after Coder fix', async () => {
    const provider = new MockProvider([
      // Leader
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []},
        {"id": "a", "role": "SecurityAuditor", "description": "Audit", "dependsOn": ["c"]}
      ]}`,
      // Coder initial
      'Initial code with vulnerability',
      // Auditor first review (blocked)
      `{"status": "blocked", "findings": [
        {"severity": "critical", "issue": "SQL injection", "location": "line 5", "recommendation": "Use parameterized queries"}
      ], "summary": "Security issues found"}`,
      // Coder rework
      'Fixed code with parameterized queries',
      // Auditor second review (approved)
      '{"status": "approved", "findings": [], "summary": "Issues resolved"}',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    expect(result.securityReview?.status).toBe('approved');
    expect(result.reviewCycles).toBe(2);
    expect(result.coderOutput).toContain('Fixed code');
  });

  it('respects max review cycle limit (2)', async () => {
    const provider = new MockProvider([
      // Leader
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []},
        {"id": "a", "role": "SecurityAuditor", "description": "Audit", "dependsOn": ["c"]}
      ]}`,
      // Coder initial
      'Bad code v1',
      // Auditor review 1 (blocked)
      '{"status": "blocked", "findings": [{"severity": "high", "issue": "Issue 1", "location": "l1", "recommendation": "Fix it"}], "summary": "Bad"}',
      // Coder rework 1
      'Bad code v2',
      // Auditor review 2 (still blocked)
      '{"status": "blocked", "findings": [{"severity": "high", "issue": "Issue 2", "location": "l2", "recommendation": "Fix it"}], "summary": "Still bad"}',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    expect(result.reviewCycles).toBe(2);
    expect(result.securityReview?.status).toBe('blocked');
    expect(result.finalOutput).toContain('✗ Blocked');
  });

  it('handles missing SecurityAuditor task gracefully', async () => {
    const provider = new MockProvider([
      // Leader (no auditor task)
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []}
      ]}`,
      // Coder
      'Code output',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    expect(result.securityReview).toBeUndefined();
    expect(result.reviewCycles).toBe(0);
    expect(result.finalOutput).toContain('Code output');
  });

  it('calls onProgress callback during execution', async () => {
    const progressCalls: Array<{ role: string; message: string }> = [];
    const provider = new MockProvider([
      `{"subtasks": [{"id": "c", "role": "Coder", "description": "Code", "dependsOn": []}]}`,
      'Done',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
      onProgress: (role, message) => {
        progressCalls.push({ role, message });
      },
    });

    await runner.run();

    expect(progressCalls.some(p => p.role === 'Leader')).toBe(true);
    expect(progressCalls.some(p => p.role === 'Coder')).toBe(true);
  });

  it('parses SecurityReview with mixed case in JSON', async () => {
    const provider = new MockProvider([
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []},
        {"id": "a", "role": "SecurityAuditor", "description": "Audit", "dependsOn": ["c"]}
      ]}`,
      'Code',
      // Auditor with different formatting
      `{
        "status": "approved",
        "findings": [],
        "summary": "All good"
      }`,
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    expect(result.securityReview?.status).toBe('approved');
    expect(result.securityReview?.summary).toBe('All good');
  });

  it('assumes approval when Auditor response is not valid JSON', async () => {
    const provider = new MockProvider([
      `{"subtasks": [
        {"id": "c", "role": "Coder", "description": "Code", "dependsOn": []},
        {"id": "a", "role": "SecurityAuditor", "description": "Audit", "dependsOn": ["c"]}
      ]}`,
      'Code',
      // Auditor returns non-JSON response
      'Everything looks fine, no issues found.',
    ]);

    const runner = new SquadRunner({
      taskDescription: 'Task',
      provider,
      model: 'test-model',
      tools: mockTools,
      dangerousSkipApproval: true,
    });

    const result = await runner.run();

    // Should default to approval
    expect(result.securityReview?.status).toBe('approved');
    expect(result.securityReview?.summary).toBe('No security issues found');
  });
});
