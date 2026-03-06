import type {
  GlobalConfig,
  ProjectConfig,
  ResolvedConfig,
  ModelSelectionSource,
} from './types.js';
import { readGlobalConfig, getGlobalConfigDefaults } from './GlobalConfig.js';
import { findProjectRoot, readProjectConfig } from './ProjectConfig.js';
import { readEnvOverrides, getApiKey as getEnvApiKey } from './EnvVarOverrides.js';
import { resolveProviderSecret } from '../auth/ProviderCredentialStore.js';

export interface CLIFlagOverrides {
  provider?: string;
  model?: string;
  logLevel?: ResolvedConfig['logLevel'];
  backendUrl?: string;
  dangerousSkipApproval?: boolean;
  maxIterations?: number;
}

let _resolvedConfig: ResolvedConfig | null = null;
let _resolvedConfigKey: string | null = null;

interface ModelResolutionResult {
  model: string;
  defaultModel: string;
  allowedModels: string[];
  modelSelection: ResolvedConfig['modelSelection'];
}

function resolveEpamUpstreamProvider(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith('claude-')) return 'anthropic';
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3')) {
    return 'openai';
  }
  if (normalized.startsWith('gemini-')) return 'gemini';
  return 'anthropic';
}

function normalizeLlMChain(
  provider: string,
  model: string,
  projectConfig: Partial<ProjectConfig>,
  overrideFirstSlot: boolean,
): ResolvedConfig['llmChain'] {
  // When --provider is explicitly given, replace the first slot with the
  // requested provider+model. Keep remaining slots for failover.
  const baseChain = overrideFirstSlot
    ? [{ provider, model }, ...(projectConfig.llmChain ?? []).slice(1)]
    : (projectConfig.llmChain ?? [{ provider, model }]);

  return baseChain.map(slot => {
    // If the slot explicitly specifies "epam", normalize it to its concrete upstream provider.
    if (slot.provider === 'epam') {
      return {
        ...slot,
        provider: resolveEpamUpstreamProvider(slot.model),
      };
    }
    
    // For legacy/BYOK compatibility: If provider is natively requested, we leave it as is.
    // ProviderChain and ProviderCredentialStore will later determine if there's a stored EPAM-brokered
    // credential or temporary bridge credential that satisfies this native provider request.
    return slot;
  });
}

function createCacheKey(flags: CLIFlagOverrides): string {
  return JSON.stringify({
    provider: flags.provider ?? null,
    model: flags.model ?? null,
    logLevel: flags.logLevel ?? null,
    backendUrl: flags.backendUrl ?? null,
    dangerousSkipApproval: flags.dangerousSkipApproval ?? null,
    maxIterations: flags.maxIterations ?? null,
  });
}

function normalizeAllowedModels(models: ProjectConfig['allowedModels']): string[] {
  const normalized = (models ?? [])
    .map(model => model?.trim())
    .filter((model): model is string => Boolean(model));

  return [...new Set(normalized)];
}

function validateAllowedModel(model: string, allowedModels: string[], label: string): string {
  if (!allowedModels.includes(model)) {
    throw new Error(
      `${label} "${model}" is not in the configured EPAM model registry. Allowed models: ${allowedModels.join(', ')}.`
    );
  }

  return model;
}

function selectConfiguredEpamModel(
  requestedModel: string | undefined,
  requestedSource: ModelSelectionSource | null,
  projectConfig: Partial<ProjectConfig>,
): ModelResolutionResult {
  const allowedModels = normalizeAllowedModels(projectConfig.allowedModels);
  if (allowedModels.length === 0) {
    throw new Error(
      'Provider "epam" requires a non-empty allowedModels list in .epam/settings.json.'
    );
  }

  const configuredDefaultModel = projectConfig.defaultModel?.trim() || undefined;
  const legacyProjectModel = projectConfig.model?.trim() || undefined;

  const defaultModel = configuredDefaultModel
    ? validateAllowedModel(configuredDefaultModel, allowedModels, 'Configured default model')
    : legacyProjectModel
      ? validateAllowedModel(legacyProjectModel, allowedModels, 'Configured project model')
      : allowedModels[0];

  if (requestedModel) {
    return {
      model: validateAllowedModel(requestedModel, allowedModels, 'Requested model'),
      defaultModel,
      allowedModels,
      modelSelection: {
        source: requestedSource ?? 'standard',
        usedDefault: false,
        requestedModel,
        reason: `using explicitly requested model "${requestedModel}"`,
      },
    };
  }

  const source: ModelSelectionSource = configuredDefaultModel
    ? 'project-default'
    : legacyProjectModel
      ? 'project-model'
      : 'allowed-models-first';

  const reason = configuredDefaultModel
    ? `using configured default model "${defaultModel}"`
    : legacyProjectModel
      ? `using configured project model "${defaultModel}"`
      : `using first allowed model "${defaultModel}"`;

  return {
    model: defaultModel,
    defaultModel,
    allowedModels,
    modelSelection: {
      source,
      usedDefault: true,
      requestedModel: null,
      reason,
    },
  };
}

function selectStandardModel(
  requestedModel: string | undefined,
  globalConfig: Partial<GlobalConfig>,
  defaults: GlobalConfig,
  projectConfig: Partial<ProjectConfig>,
): ModelResolutionResult {
  const model =
    requestedModel ??
    projectConfig.model ??
    globalConfig.defaultModel ??
    defaults.defaultModel;

  return {
    model,
    defaultModel: model,
    allowedModels: [],
    modelSelection: {
      source: 'standard',
      usedDefault: requestedModel == null,
      requestedModel: requestedModel ?? null,
      reason: requestedModel
        ? `using explicitly requested model "${requestedModel}"`
        : `using resolved model "${model}"`,
    },
  };
}

export function resolveModelRegistry(
  provider: string,
  projectConfig: Partial<ProjectConfig>,
  globalConfig: Partial<GlobalConfig>,
  defaults: GlobalConfig,
  flags: CLIFlagOverrides,
  envOverrides: ReturnType<typeof readEnvOverrides>,
): ModelResolutionResult {
  const requestedModel =
    flags.model ??
    envOverrides.model;

  const requestedSource: ModelSelectionSource | null =
    flags.model != null
      ? 'flag'
      : envOverrides.model != null
        ? 'env'
        : null;

  if (provider === 'epam') {
    return selectConfiguredEpamModel(requestedModel, requestedSource, projectConfig);
  }

  return selectStandardModel(requestedModel, globalConfig, defaults, projectConfig);
}

export async function resolveConfig(flags: CLIFlagOverrides = {}): Promise<ResolvedConfig> {
  const cacheKey = createCacheKey(flags);
  if (_resolvedConfig && _resolvedConfigKey === cacheKey) return _resolvedConfig;

  const defaults = getGlobalConfigDefaults();
  const globalConfig = await readGlobalConfig();

  const projectRoot = await findProjectRoot(process.cwd());
  const projectConfig = projectRoot ? await readProjectConfig(projectRoot) : {};

  const envOverrides = readEnvOverrides();
  const provider =
    flags.provider ??
    envOverrides.provider ??
    projectConfig.provider ??
    globalConfig.defaultProvider ??
    defaults.defaultProvider;
  const modelResolution = resolveModelRegistry(
    provider,
    projectConfig,
    globalConfig,
    defaults,
    flags,
    envOverrides,
  );

  // Priority: flags > env > project > global > defaults
  const merged: ResolvedConfig = {
    backendUrl:
      flags.backendUrl ??
      envOverrides.backendUrl ??
      globalConfig.backendUrl ??
      defaults.backendUrl,

    provider,
    model: modelResolution.model,
    defaultModel: modelResolution.defaultModel,
    allowedModels: modelResolution.allowedModels,
    modelSelection: modelResolution.modelSelection,

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
      warningAt:    envOverrides.budgetWarningAt  ?? projectConfig.budgetGuardrails?.warningAt    ?? 4.00,
      hardLimit:    envOverrides.budgetHardLimit  ?? projectConfig.budgetGuardrails?.hardLimit    ?? 5.00,
      autoDowngrade: projectConfig.budgetGuardrails?.autoDowngrade ?? true,
    },

    // llmChain: normalize EPAM registry slots to the concrete upstream provider understood by the proxy.
    llmChain: normalizeLlMChain(provider, modelResolution.model, projectConfig, flags.provider != null),
  };

  _resolvedConfig = merged;
  _resolvedConfigKey = cacheKey;
  return merged;
}

export function resetResolvedConfig(): void {
  _resolvedConfig = null;
  _resolvedConfigKey = null;
}

/**
 * Resolves the API key for a provider, checking env vars first, then the
 * ProviderCredentialStore (stored via `epam provider login`).
 */
export async function resolveApiKey(provider: string): Promise<string | null> {
  return getEnvApiKey(provider) ?? await resolveProviderSecret(provider) ?? null;
}

export async function getConfig(): Promise<ResolvedConfig> {
  return resolveConfig();
}
