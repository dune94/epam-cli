export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | ContentPart[];
}

export interface ContentPart {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentPart[];
  tool_use_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ProviderRequest {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Reasoning effort level — controls thinking depth. Providers map this to their native parameter. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  responseFormat?: 'json_object';
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  content: ContentPart[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: TokenUsage;
}

export type StreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; id: string; name: string; input: string }
  | { type: 'message_stop'; stopReason: ProviderResponse['stopReason'] }
  | { type: 'error'; error: Error };

export type StreamHandler = (delta: StreamDelta) => void;

/** Glob-to-regex helper, same pattern as spec-mode-runner.js's resolveModelProvider
 *  and claude.sh's resolve_model_provider() — config-driven, no hardcoded vendor
 *  names in the matching logic itself. */
function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

/**
 * Resolves the effective temperature for a request: explicit request.temperature
 * takes priority, then EPAM_TEMPERATURE (set per-story or project-wide by the
 * orchestration layer — e.g. 0 for reduced token-selection variance), then the
 * provider's own default. Mirrors the same request-field-then-env-var-then-default
 * pattern already used for reasoningEffort (see QwenProvider/MiniMaxProvider's
 * resolveReasoningEffort), so both knobs are wired consistently.
 *
 * EPAM_TEMPERATURE_MODEL_PATTERN (optional, pipe-separated globs, e.g.
 * "z-ai/glm-*|zhipuai/glm-*") scopes EPAM_TEMPERATURE to only the models it
 * matches — added 2026-07-07 per explicit direction to pin temperature for GLM
 * models specifically, not project-wide across every model in the ladder.
 * Unset (default): EPAM_TEMPERATURE applies to all models, preserving prior
 * behavior. When set and request.model doesn't match any pattern, EPAM_TEMPERATURE
 * is ignored and the provider default is used instead.
 */
export function resolveTemperature(request: ProviderRequest, defaultTemperature: number): number {
  if (typeof request.temperature === 'number') return request.temperature;

  const pattern = process.env.EPAM_TEMPERATURE_MODEL_PATTERN;
  if (pattern && request.model) {
    const matches = pattern.split('|').some((glob) => globToRegExp(glob).test(request.model as string));
    if (!matches) return defaultTemperature;
  }

  const envValue = process.env.EPAM_TEMPERATURE;
  if (envValue !== undefined && envValue !== '') {
    const parsed = parseFloat(envValue);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return defaultTemperature;
}

export interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse>;
}
