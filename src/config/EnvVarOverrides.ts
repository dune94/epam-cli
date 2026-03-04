import type { ResolvedConfig } from './types.js';

export interface EnvOverrides {
  backendUrl?: string;
  provider?: string;
  model?: string;
  logLevel?: ResolvedConfig['logLevel'];
  apiKeyAnthropic?: string;
  apiKeyOpenAI?: string;
  apiKeyGemini?: string;
  dangerousSkipApproval?: boolean;
  maxIterations?: number;
  budgetWarningAt?: number;
  budgetHardLimitAt?: number;
  maxOutputTokens?: number;
}

export function readEnvOverrides(): EnvOverrides {
  const overrides: EnvOverrides = {};

  if (process.env.EPAM_BACKEND_URL) {
    overrides.backendUrl = process.env.EPAM_BACKEND_URL;
  }
  if (process.env.EPAM_PROVIDER) {
    overrides.provider = process.env.EPAM_PROVIDER;
  }
  if (process.env.EPAM_MODEL) {
    overrides.model = process.env.EPAM_MODEL;
  }
  if (process.env.EPAM_LOG_LEVEL) {
    overrides.logLevel = process.env.EPAM_LOG_LEVEL as ResolvedConfig['logLevel'];
  }
  if (process.env.EPAM_API_KEY_ANTHROPIC) {
    overrides.apiKeyAnthropic = process.env.EPAM_API_KEY_ANTHROPIC;
  }
  if (process.env.EPAM_API_KEY_OPENAI) {
    overrides.apiKeyOpenAI = process.env.EPAM_API_KEY_OPENAI;
  }
  if (process.env.EPAM_API_KEY_GEMINI) {
    overrides.apiKeyGemini = process.env.EPAM_API_KEY_GEMINI;
  }
  if (process.env.EPAM_DANGEROUS_SKIP_APPROVAL === '1') {
    overrides.dangerousSkipApproval = true;
  }
  if (process.env.EPAM_MAX_ITERATIONS) {
    const n = parseInt(process.env.EPAM_MAX_ITERATIONS, 10);
    if (!isNaN(n)) overrides.maxIterations = n;
  }
  if (process.env.EPAM_BUDGET_WARNING_AT) {
    const n = parseFloat(process.env.EPAM_BUDGET_WARNING_AT);
    if (!isNaN(n)) overrides.budgetWarningAt = n;
  }
  if (process.env.EPAM_BUDGET_HARD_LIMIT_AT) {
    const n = parseFloat(process.env.EPAM_BUDGET_HARD_LIMIT_AT);
    if (!isNaN(n)) overrides.budgetHardLimitAt = n;
  }
  if (process.env.EPAM_MAX_OUTPUT_TOKENS) {
    const n = parseInt(process.env.EPAM_MAX_OUTPUT_TOKENS, 10);
    if (!isNaN(n)) overrides.maxOutputTokens = n;
  }

  return overrides;
}

export function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
    case 'claude':
      return process.env.EPAM_API_KEY_ANTHROPIC;
    case 'openai':
      return process.env.EPAM_API_KEY_OPENAI;
    case 'gemini':
      return process.env.EPAM_API_KEY_GEMINI;
    case 'cursor':
      return process.env.CURSOR_API_KEY ?? process.env.EPAM_API_KEY_CURSOR;
    case 'qwen':
      return process.env.OPENROUTER_API_KEY ?? process.env.EPAM_API_KEY_OPENROUTER ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY ?? process.env.EPAM_API_KEY_QWEN;
    default:
      return undefined;
  }
}
