export interface ProviderSlot {
  provider: string; // 'anthropic' | 'openai' | 'gemini'
  model: string;
  label?: string; // optional friendly name
}

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unavailable';

export interface HealthRecord {
  slot: ProviderSlot;
  status: HealthStatus;
  failureCount: number;
  lastFailureAt: number | null;
  lastError: string | null;
  cooldownMs: number;
}

export type FailoverDecision = 'failover' | 'fatal' | 'retry_same';

export interface FailoverAnalysis {
  decision: FailoverDecision;
  reason: string;
  statusCode?: number;
}
