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

  return overrides;
}

export function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return process.env.EPAM_API_KEY_ANTHROPIC;
    case 'openai':
      return process.env.EPAM_API_KEY_OPENAI;
    case 'gemini':
      return process.env.EPAM_API_KEY_GEMINI;
    default:
      return undefined;
  }
}
