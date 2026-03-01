import type { LLMProvider, TokenUsage, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import type { BudgetGuard, BudgetCheckResult } from '../billing/BudgetGuard.js';
import type { ToolRunner } from './tools/ToolRunner.js';

export interface AgentRunOptions {
  userMessage: string;
  systemPrompt: string;
  provider: LLMProvider;
  model: string;
  tools: Tool[];
  maxIterations?: number;
  /** Prior conversation history to prepend before the current user message. */
  history?: Message[];
  /** Token threshold at which the runner auto-compresses older messages. */
  autoCompressAt?: number;
  /** Max characters per tool result before truncation (default: 32768). */
  maxToolOutputChars?: number;
  /** Maximum output tokens per LLM response (default: 16384). */
  maxOutputTokens?: number;
  /** Skip interactive tool approval prompts (for CI/non-interactive use). */
  dangerousSkipApproval?: boolean;
  /** Shared budget guard instance for cross-turn cost enforcement. */
  budgetGuard?: BudgetGuard;
  /** Tool runner instance for permission and state management. */
  toolRunner?: ToolRunner;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string, isError: boolean) => void;
  onIterationStart?: (iteration: number) => void;
  /** Fired when a budget threshold is crossed (warning, downgrade, or pause). */
  onBudgetCheck?: (result: BudgetCheckResult) => void;
}

export interface AgentRunResult {
  finalResponse: string;
  toolCallCount: number;
  iterations: number;
  usage: TokenUsage;
  /** Full message array at end of run, including history + this turn's exchanges. */
  messages: Message[];
}

export interface PlanStep {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  result?: string;
  error?: string;
}
