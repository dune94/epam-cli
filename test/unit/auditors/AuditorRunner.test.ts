import { describe, expect, it, vi } from 'vitest';
import { AuditorRunner } from '../../../src/auditors/AuditorRunner.js';
import type { AuditorConfig, AuditorResult } from '../../../src/auditors/types.js';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
  StreamHandler,
} from '../../../src/providers/types.js';

class SpyProvider implements LLMProvider {
  readonly name = 'spy';
  readonly defaultModel = 'spy-model';
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(): Promise<ProviderResponse> {
    throw new Error('unused');
  }

  async stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse> {
    this.requests.push(request);
    const text = this.responses[this.requests.length - 1] ?? '[SEVERITY: info] No findings.';
    handler({ type: 'text_delta', text });
    handler({ type: 'message_stop', stopReason: 'end_turn' });
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function createConfig(overrides: Partial<AuditorConfig> = {}): AuditorConfig {
  return {
    name: 'security-sarah',
    persona: 'Senior security reviewer',
    focus: 'Application security',
    severity_threshold: 'warning',
    model: 'claude-test',
    ...overrides,
  };
}

describe('AuditorRunner', () => {
  it('injects persona-specific system prompts', async () => {
    const provider = new SpyProvider(['[SEVERITY: warning] Missing auth check']);
    const runner = new AuditorRunner(createConfig(), provider, []);

    await runner.run({
      userMessage: 'Review login flow',
      proposedResponse: 'Looks fine',
      conversationHistory: [{ role: 'user', content: 'prior context' }],
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.systemPrompt).toContain('You are security-sarah.');
    expect(provider.requests[0]?.systemPrompt).toContain('Persona: Senior security reviewer');
    expect(provider.requests[0]?.systemPrompt).toContain('Primary focus: Application security');
  });

  it('does not treat "No findings." as a blocking issue at info threshold', async () => {
    const provider = new SpyProvider(['[SEVERITY: info] No findings.']);
    const runner = new AuditorRunner(createConfig({ severity_threshold: 'info' }), provider, []);

    const result = await runner.run({
      userMessage: 'Review',
      proposedResponse: 'Response',
      conversationHistory: [],
    });

    expect(result.findings).toEqual([]);
    expect(runner.exceedsThreshold(result)).toBe(false);
  });

  it('keeps parallel auditor instances isolated', async () => {
    const provider = new SpyProvider([
      '[SEVERITY: warning] Auditor one finding',
      '[SEVERITY: critical] Auditor two finding',
    ]);
    const first = new AuditorRunner(createConfig({ name: 'auditor-one', persona: 'First persona' }), provider, []);
    const second = new AuditorRunner(createConfig({ name: 'auditor-two', persona: 'Second persona' }), provider, []);

    const [firstResult, secondResult] = await Promise.all([
      first.run({
        userMessage: 'User message one',
        proposedResponse: 'Response one',
        conversationHistory: [{ role: 'user', content: 'ctx one' }],
      }),
      second.run({
        userMessage: 'User message two',
        proposedResponse: 'Response two',
        conversationHistory: [{ role: 'user', content: 'ctx two' }],
      }),
    ]);

    expect(firstResult.auditorName).toBe('auditor-one');
    expect(secondResult.auditorName).toBe('auditor-two');
    expect(firstResult.findings[0]?.finding).toContain('Auditor one');
    expect(secondResult.findings[0]?.finding).toContain('Auditor two');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.systemPrompt).toContain('You are auditor-one.');
    expect(provider.requests[1]?.systemPrompt).toContain('You are auditor-two.');
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain('User message one');
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain('User message two');
  });

  it('blocks only auditors that meet or exceed their configured threshold', () => {
    const warningRunner = new AuditorRunner(createConfig({ name: 'warn', severity_threshold: 'warning' }), {
      name: 'noop',
      defaultModel: 'noop',
      async complete() { throw new Error('unused'); },
      async stream() { throw new Error('unused'); },
    }, []);
    const criticalRunner = new AuditorRunner(createConfig({ name: 'critical', severity_threshold: 'critical' }), {
      name: 'noop',
      defaultModel: 'noop',
      async complete() { throw new Error('unused'); },
      async stream() { throw new Error('unused'); },
    }, []);

    const results: AuditorResult[] = [
      {
        auditorName: 'warn',
        findings: [{ auditorName: 'warn', severity: 'warning', finding: 'Warning finding' }],
        transcript: '[SEVERITY: warning] Warning finding',
        severity: 'warning',
      },
      {
        auditorName: 'critical',
        findings: [{ auditorName: 'critical', severity: 'warning', finding: 'Below threshold' }],
        transcript: '[SEVERITY: warning] Below threshold',
        severity: 'warning',
      },
    ];

    const gate = AuditorRunner.evaluateGate(results, [warningRunner, criticalRunner]);

    expect(gate.blocked).toBe(true);
    expect(gate.blockingAuditors).toHaveLength(1);
    expect(gate.blockingAuditors[0]?.auditorName).toBe('warn');
  });
});
