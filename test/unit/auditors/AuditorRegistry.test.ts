import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditorRegistry } from '../../../src/auditors/AuditorRegistry.js';
import type { LLMProvider, ProviderRequest, ProviderResponse, StreamHandler } from '../../../src/providers/types.js';

describe('AuditorRegistry', () => {
  const tempRoots: string[] = [];

  async function createProjectRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epam-auditors-'));
    await fs.mkdir(path.join(root, '.epam'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.epam', 'auditors.json'),
      JSON.stringify({
        auditors: [
          {
            name: 'security-sarah',
            persona: 'Security reviewer',
            focus: 'Security',
            severity_threshold: 'warning',
            model: 'claude-test',
          },
        ],
      }),
      'utf-8'
    );
    tempRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('toggles enabled auditors per session', async () => {
    const root = await createProjectRoot();
    const registry = new AuditorRegistry(root);
    await registry.load();

    expect(registry.getEnabled()).toEqual([]);

    registry.toggle(true);
    expect(registry.getEnabled()).toHaveLength(1);

    registry.toggle(false);
    expect(registry.getEnabled()).toEqual([]);
  });

  it('creates isolated runner instances for enabled auditors', async () => {
    const root = await createProjectRoot();
    const registry = new AuditorRegistry(root);
    await registry.load();
    registry.toggle(true);

    const provider: LLMProvider = {
      name: 'noop',
      defaultModel: 'noop',
      async complete(_request: ProviderRequest): Promise<ProviderResponse> {
        throw new Error('unused');
      },
      async stream(_request: ProviderRequest, _handler: StreamHandler): Promise<ProviderResponse> {
        throw new Error('unused');
      },
    };

    const first = registry.getEnabledRunners(provider, []);
    const second = registry.getEnabledRunners(provider, []);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.name).toBe('security-sarah');
  });
});
