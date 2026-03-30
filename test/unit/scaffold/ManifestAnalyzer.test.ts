import { describe, expect, it } from 'vitest';
import { analyzeManifest, generatePrd, proposeAgents } from '../../../src/scaffold/ManifestAnalyzer.js';
import type { LLMProvider, ProviderRequest, ProviderResponse, StreamDelta, StreamHandler } from '../../../src/providers/types.js';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly defaultModel = 'mock-model';

  constructor(private readonly responses: string[]) {}

  private index = 0;
  requests: ProviderRequest[] = [];

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const text = this.responses[this.index++] ?? '';
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }

  async stream(_request: ProviderRequest, _handler: StreamHandler): Promise<ProviderResponse> {
    throw new Error('not implemented');
  }
}

describe('ManifestAnalyzer', () => {
  it('parses manifest analysis JSON wrapped in prose', async () => {
    const provider = new MockProvider([
      [
        'Analysis complete.',
        '```json',
        '{"summary":"Docs site","projectName":"go-transit-docs","suggestedPrefix":"GOT","techStack":["astro","typescript"],"questions":["Who owns deployment?"]}',
        '```',
      ].join('\n'),
    ]);

    const result = await analyzeManifest(provider, 'test-model', '# Manifest');

    expect(result.projectName).toBe('go-transit-docs');
    expect(result.techStack).toEqual(['astro', 'typescript']);
    expect(provider.requests).toHaveLength(1);
  });

  it('repairs prose-only manifest analysis with a second call', async () => {
    const provider = new MockProvider([
      [
        '**Specific ambiguities to clarify**',
        '- Deployment target is not explicit.',
        '- User personas are implied but unnamed.',
      ].join('\n'),
      '{"summary":"Transit docs portal","projectName":"go-transit-docs","suggestedPrefix":"GOT","techStack":["astro","typescript"],"questions":["What environment hosts the site?","Who are the primary readers?"]}',
    ]);

    const result = await analyzeManifest(provider, 'test-model', '# Manifest');

    expect(result.suggestedPrefix).toBe('GOT');
    expect(result.questions).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages[0]).toMatchObject({
      role: 'user',
    });
    expect(String(provider.requests[1]?.messages[0]?.content)).toContain('Convert this response into valid JSON');
  });

  it('repairs manifest analysis when initial JSON has the wrong shape', async () => {
    const provider = new MockProvider([
      '{"message":"Thanks for the manifest","notes":["needs clarification"]}',
      '{"summary":"Transit docs portal","projectName":"go-transit-docs","suggestedPrefix":"GOT","techStack":["astro","typescript"],"questions":["What environment hosts the site?"]}',
    ]);

    const result = await analyzeManifest(provider, 'test-model', '# Manifest');

    expect(result.summary).toBe('Transit docs portal');
    expect(result.projectName).toBe('go-transit-docs');
    expect(provider.requests).toHaveLength(2);
  });

  it('repairs agent proposals when the first response is not valid JSON', async () => {
    const provider = new MockProvider([
      'Recommended roles: frontend engineer, content pipeline engineer.',
      '{"proposedAgents":[{"name":"frontend-engineer","systemPrompt":"Owns UI delivery for the docs site.","rationale":"Needed for frontend implementation."}]}',
    ]);

    const result = await proposeAgents(provider, 'test-model', '# Manifest', []);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('frontend-engineer');
    expect(provider.requests).toHaveLength(2);
  });

  it('normalizes PRD responses that wrap top-level fields under projectMetadata', async () => {
    const provider = new MockProvider([
      JSON.stringify({
        projectMetadata: {
          id: 'ADOC-PRD-azure-docs',
          title: 'Azure GO Transit Docs CLI',
          version: '1.0.0',
          lastUpdated: '2026-03-13',
          project: {
            name: 'azure.docs.gotransit.com',
            description: 'Transit docs generator',
            stack: { language: 'TypeScript', runtime: 'Node.js' },
          },
        },
        userStories: [
          {
            id: 'ADOC-001',
            title: 'Generate docs',
            description: 'Generate docs from content sources',
            priority: 'high',
            status: 'pending',
            completed: false,
            agentGroup: 'main',
            agentRole: 'cli-pipeline-engineer',
            acceptanceCriteria: ['CLI generates output', 'Errors are reported'],
            dependencies: [],
            estimatedHours: 4,
            technicalNotes: { files: ['src/index.ts'], requiredSkills: ['typescript'] },
            storyType: 'implementation',
            effort: 'medium',
          },
        ],
        implementationOrder: {
          foundation: ['ADOC-001'],
        },
        phasesConfig: {
          foundation: {
            orchestrationMode: 'bash',
            description: 'Foundation phase',
          },
        },
      }),
    ]);

    const result = await generatePrd(
      provider,
      'test-model',
      '# Manifest',
      [],
      ['cli-pipeline-engineer'],
      'ADOC',
    );

    expect(result.id).toBe('ADOC-PRD-azure-docs');
    expect(result.project.name).toBe('azure.docs.gotransit.com');
    expect(result.stories).toHaveLength(1);
  });
});
