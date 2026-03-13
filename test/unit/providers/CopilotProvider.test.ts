import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CopilotProvider, createCopilotProvider } from '../../../src/providers/copilot/CopilotProvider.js';

describe('CopilotProvider', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('uses direct Copilot chat auth for Claude models and normalizes hyphen aliases', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ finish_reason: 'stop', message: { content: 'hi', role: 'assistant' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CopilotProvider({ model: 'claude-sonnet-4-6', token: 'gho_test_token' });

    const result = await provider.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      maxTokens: 8,
    });

    expect(result.content[0].text).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer gho_test_token',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Version': 'vscode/1.96.0',
      'Editor-Plugin-Version': 'copilot-chat/0.24.0',
      'User-Agent': 'GitHubCopilotChat/0.24.0',
    });

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('claude-sonnet-4.6');
    expect(body.max_tokens).toBe(8);
  });

  it('creates a provider from Copilot CLI plaintext config', async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), 'copilot-provider-'));
    writeFileSync(join(copilotHome, 'config.json'), JSON.stringify({
      oauth_token: 'gho_config_token',
      last_logged_in_user: { login: 'octocat' },
    }));

    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    process.env.COPILOT_HOME = copilotHome;

    const provider = await createCopilotProvider('claude-sonnet-4.6');

    expect(provider).not.toBeNull();
    expect((provider as CopilotProvider & { token: string }).token).toBe('gho_config_token');

    rmSync(copilotHome, { recursive: true, force: true });
  });
});
