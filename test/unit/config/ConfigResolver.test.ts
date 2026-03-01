import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveConfig, resetResolvedConfig } from '../../../src/config/ConfigResolver.js';

vi.mock('../../../src/config/ProjectConfig.js', () => ({
  findProjectRoot: vi.fn().mockResolvedValue(null),
  readProjectConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/config/GlobalConfig.js', () => ({
  readGlobalConfig: vi.fn().mockResolvedValue({}),
  getGlobalConfigDefaults: vi.fn().mockReturnValue({
    backendUrl: 'https://api.epam.example.com',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
  }),
  writeGlobalConfig: vi.fn().mockResolvedValue(undefined),
  getGlobalConfigPath: vi.fn().mockReturnValue('/mock/.epam/config.json'),
}));

describe('ConfigResolver', () => {
  beforeEach(() => resetResolvedConfig());
  afterEach(() => resetResolvedConfig());

  it('returns defaults when no config exists', async () => {
    const config = await resolveConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.maxIterations).toBe(20);
  });

  it('CLI flags override defaults', async () => {
    const config = await resolveConfig({ provider: 'openai', model: 'gpt-4o' });
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4o');
  });

  it('EPAM_PROVIDER env var overrides defaults', async () => {
    process.env.EPAM_PROVIDER = 'gemini';
    process.env.EPAM_MODEL = 'gemini-1.5-pro';
    try {
      const config = await resolveConfig();
      expect(config.provider).toBe('gemini');
      expect(config.model).toBe('gemini-1.5-pro');
    } finally {
      delete process.env.EPAM_PROVIDER;
      delete process.env.EPAM_MODEL;
      resetResolvedConfig();
    }
  });

  it('CLI flags override env vars', async () => {
    process.env.EPAM_PROVIDER = 'gemini';
    try {
      const config = await resolveConfig({ provider: 'openai' });
      expect(config.provider).toBe('openai');
    } finally {
      delete process.env.EPAM_PROVIDER;
      resetResolvedConfig();
    }
  });

  it('dangerousSkipApproval is false by default', async () => {
    const config = await resolveConfig();
    expect(config.tools.dangerousSkipApproval).toBe(false);
  });

  it('EPAM_DANGEROUS_SKIP_APPROVAL=1 enables skip approval', async () => {
    process.env.EPAM_DANGEROUS_SKIP_APPROVAL = '1';
    try {
      const config = await resolveConfig();
      expect(config.tools.dangerousSkipApproval).toBe(true);
    } finally {
      delete process.env.EPAM_DANGEROUS_SKIP_APPROVAL;
      resetResolvedConfig();
    }
  });

  it('caches resolved config on repeated calls', async () => {
    const config1 = await resolveConfig();
    const config2 = await resolveConfig();
    expect(config1).toBe(config2);
  });

  it('resetResolvedConfig clears the cache', async () => {
    const config1 = await resolveConfig();
    resetResolvedConfig();
    const config2 = await resolveConfig();
    expect(config1).not.toBe(config2);
  });

  it('budgetGuardrails defaults to Infinity (no limits)', async () => {
    const config = await resolveConfig();
    expect(config.budgetGuardrails.warningAt).toBe(Infinity);
    expect(config.budgetGuardrails.hardLimitAt).toBe(Infinity);
    expect(config.budgetGuardrails.onHardLimit).toBe('downgrade');
  });

  it('EPAM_BUDGET_WARNING_AT and EPAM_BUDGET_HARD_LIMIT_AT env vars set budget limits', async () => {
    process.env.EPAM_BUDGET_WARNING_AT = '5.00';
    process.env.EPAM_BUDGET_HARD_LIMIT_AT = '10.00';
    try {
      const config = await resolveConfig();
      expect(config.budgetGuardrails.warningAt).toBe(5.00);
      expect(config.budgetGuardrails.hardLimitAt).toBe(10.00);
    } finally {
      delete process.env.EPAM_BUDGET_WARNING_AT;
      delete process.env.EPAM_BUDGET_HARD_LIMIT_AT;
      resetResolvedConfig();
    }
  });
});
