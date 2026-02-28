import type { GlobalConfig, ProjectConfig, ResolvedConfig, BudgetGuardrails } from './types.js';
import { readGlobalConfig, getGlobalConfigDefaults } from './GlobalConfig.js';
import { findProjectRoot, readProjectConfig } from './ProjectConfig.js';
import { readEnvOverrides } from './EnvVarOverrides.js';

export interface CLIFlagOverrides {
  provider?: string;
  model?: string;
  logLevel?: ResolvedConfig['logLevel'];
  backendUrl?: string;
  dangerousSkipApproval?: boolean;
  maxIterations?: number;
}

let _resolvedConfig: ResolvedConfig | null = null;

export async function resolveConfig(flags: CLIFlagOverrides = {}): Promise<ResolvedConfig> {
  if (_resolvedConfig) return _resolvedConfig;

  const defaults = getGlobalConfigDefaults();
  const globalConfig = await readGlobalConfig();

  const projectRoot = await findProjectRoot(process.cwd());
  const projectConfig = projectRoot ? await readProjectConfig(projectRoot) : {};

  const envOverrides = readEnvOverrides();

  // Priority: flags > env > project > global > defaults
  const merged: ResolvedConfig = {
    backendUrl:
      flags.backendUrl ??
      envOverrides.backendUrl ??
      globalConfig.backendUrl ??
      defaults.backendUrl,

    provider:
      flags.provider ??
      envOverrides.provider ??
      projectConfig.provider ??
      globalConfig.defaultProvider ??
      defaults.defaultProvider,

    model:
      flags.model ??
      envOverrides.model ??
      projectConfig.model ??
      globalConfig.defaultModel ??
      defaults.defaultModel,

    logLevel:
      flags.logLevel ??
      envOverrides.logLevel ??
      globalConfig.logLevel ??
      defaults.logLevel,

    theme: globalConfig.theme ?? defaults.theme,
    telemetry: globalConfig.telemetry ?? defaults.telemetry,
    autoUpdate: globalConfig.autoUpdate ?? defaults.autoUpdate,

    systemPromptFile: projectConfig.systemPromptFile ?? null,

    contextFile:
      projectConfig.contextFile ??
      (projectRoot ? '.epam/context.md' : '.epam/context.md'),

    tools: {
      enabled: projectConfig.tools?.enabled ?? [],
      disabled: projectConfig.tools?.disabled ?? [],
      dangerousSkipApproval:
        flags.dangerousSkipApproval ??
        envOverrides.dangerousSkipApproval ??
        projectConfig.tools?.dangerousSkipApproval ??
        false,
    },

    maxIterations:
      flags.maxIterations ??
      envOverrides.maxIterations ??
      projectConfig.maxIterations ??
      20,

    autoCompressAt: projectConfig.autoCompressAt ?? 80000,

    maxOutputTokens:
      envOverrides.maxOutputTokens ??
      projectConfig.maxOutputTokens ??
      16384,

    projectRoot,

    budgetGuardrails: {
      warningAt:   envOverrides.budgetWarningAt   ?? projectConfig.budgetGuardrails?.warningAt   ?? Infinity,
      hardLimitAt: envOverrides.budgetHardLimitAt ?? projectConfig.budgetGuardrails?.hardLimitAt ?? Infinity,
      onHardLimit: projectConfig.budgetGuardrails?.onHardLimit ?? 'downgrade',
    },

    // llmChain: use project config if defined, else build a single-slot chain from provider+model
    llmChain: projectConfig.llmChain ?? [
      {
        provider:
          flags.provider ??
          envOverrides.provider ??
          projectConfig.provider ??
          globalConfig.defaultProvider ??
          defaults.defaultProvider,
        model:
          flags.model ??
          envOverrides.model ??
          projectConfig.model ??
          globalConfig.defaultModel ??
          defaults.defaultModel,
      },
    ],
  };

  _resolvedConfig = merged;
  return merged;
}

export function resetResolvedConfig(): void {
  _resolvedConfig = null;
}

export async function getConfig(): Promise<ResolvedConfig> {
  return resolveConfig();
}
