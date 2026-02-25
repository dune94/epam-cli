export class EpamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EpamError';
  }
}

export class AuthError extends EpamError {
  constructor(message: string, cause?: Error) {
    super(message, 'AUTH_ERROR', cause);
    this.name = 'AuthError';
  }
}

export class ConfigError extends EpamError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

export class ProviderError extends EpamError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    cause?: Error
  ) {
    super(message, 'PROVIDER_ERROR', cause);
    this.name = 'ProviderError';
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: string, retryAfterSeconds?: number) {
    const hint = retryAfterSeconds != null ? ` Retry after ${retryAfterSeconds}s.` : '';
    super(`${provider}: rate limit exceeded.${hint}`, 429);
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderOverloadedError extends ProviderError {
  constructor(provider: string) {
    super(`${provider}: service overloaded or unavailable.`, 503);
    this.name = 'ProviderOverloadedError';
  }
}

export class ToolError extends EpamError {
  constructor(message: string, cause?: Error) {
    super(message, 'TOOL_ERROR', cause);
    this.name = 'ToolError';
  }
}

export class AgentError extends EpamError {
  constructor(message: string, cause?: Error) {
    super(message, 'AGENT_ERROR', cause);
    this.name = 'AgentError';
  }
}

export class BillingError extends EpamError {
  constructor(message: string, cause?: Error) {
    super(message, 'BILLING_ERROR', cause);
    this.name = 'BillingError';
  }
}

export function isEpamError(err: unknown): err is EpamError {
  return err instanceof EpamError;
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
