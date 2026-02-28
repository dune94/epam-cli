export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LLMChainSlot {
  provider: string;
  model: string;
  label?: string;
}

export interface GlobalConfig {
  backendUrl: string;
  defaultProvider: string;
  defaultModel: string;
  logLevel: LogLevel;
  theme: 'dark' | 'light' | 'auto';
  telemetry: boolean;
  autoUpdate: boolean;
}

export interface BudgetGuardrails {
  /** Session cost in USD at which a warning banner is shown. */
  warningAt: number;
  /** Session cost in USD at which the model is auto-downgraded or execution is paused. */
  hardLimitAt: number;
  /** When hard limit is hit: 'downgrade' switches to next cheaper chain slot, 'pause' blocks and asks user. */
  onHardLimit: 'downgrade' | 'pause';
}

export interface ProjectConfig {
  provider?: string;
  model?: string;
  systemPromptFile?: string;
  contextFile?: string;
  tools?: {
    enabled?: string[];
    disabled?: string[];
    dangerousSkipApproval?: boolean;
  };
  maxIterations?: number;
  autoCompressAt?: number;
  maxOutputTokens?: number;
  /** Priority-ordered list of LLM provider+model slots (up to 5) for failover. */
  llmChain?: LLMChainSlot[];
  /** Budget guardrails for session cost enforcement. */
  budgetGuardrails?: Partial<BudgetGuardrails>;
}

export interface ResolvedConfig {
  backendUrl: string;
  provider: string;
  model: string;
  logLevel: LogLevel;
  theme: 'dark' | 'light' | 'auto';
  telemetry: boolean;
  autoUpdate: boolean;
  systemPromptFile: string | null;
  contextFile: string;
  tools: {
    enabled: string[];
    disabled: string[];
    dangerousSkipApproval: boolean;
  };
  maxIterations: number;
  autoCompressAt: number;
  /** Maximum output tokens per LLM response (default: 16384). */
  maxOutputTokens: number;
  projectRoot: string | null;
  /** Priority-ordered failover chain. First entry mirrors provider+model when not explicitly set. */
  llmChain: LLMChainSlot[];
  /** Budget guardrails for session cost enforcement. */
  budgetGuardrails: BudgetGuardrails;
}
