import type { LLMProvider, TokenUsage, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import type { BudgetGuard, BudgetCheckResult } from '../billing/BudgetGuard.js';
import type { ToolRunner } from './tools/ToolRunner.js';
import type { AuditorRunner } from '../auditors/AuditorRunner.js';
import type { AuditorGateDecision } from '../auditors/types.js';
import type { MemoryLoader } from '../memory/MemoryLoader.js';

export interface AgentRunOptions {
  userMessage: string;
  systemPrompt: string;
  provider: LLMProvider;
  model: string;
  tools: Tool[];
  maxIterations?: number;
  /**
   * Maximum tool calls before tools are withdrawn and a final answer is
   * required. Unset = unlimited (existing behaviour).
   *
   * Distinct from maxIterations, which bounds LLM round-trips: an agent told
   * "HARD LIMIT: 6 tool calls" in its prompt kept querying past 6 and hit the
   * ITERATION cap with no answer, discarding the whole investigation. Raising
   * that cap (10 → 20 → 25 → 40) never helped because it addressed the wrong
   * limit. This one is the limit the prompt was actually describing.
   */
  maxToolCalls?: number;
  /**
   * Deadline for the forced final-answer turn (ms). Unset = no deadline.
   *
   * That turn hung indefinitely on a live run and consumed the agent's entire
   * outer timeout, so the attempt died with nothing — not even the evidence it
   * had already gathered. A hang must cost one turn, not the whole run.
   */
  finalTurnTimeoutMs?: number;
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
  /** Memory loader instance for MEMORY.md file injection. */
  memoryLoader?: MemoryLoader;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string, isError: boolean) => void;
  onIterationStart?: (iteration: number) => void;
  /**
   * Fired once per iteration with the model-latency / tool-execution split.
   *
   * Without this, a 12-minute detective attempt (metrolinx, 2026-07-30) and a
   * 23-second one (mock3, same day) could not be told apart, because the
   * detective's own transcript log carries only the prompt and the final JSON
   * — no timing, no per-call breakdown. A slow reasoning call and a slow tool
   * (e.g. a large CodeGraph query against a bigger repo) need opposite fixes;
   * EPAM_MAX_TOOL_CALLS was raised three times against exactly this blind spot
   * before anyone could see which one it actually was.
   */
  onIterationTiming?: (timing: IterationTiming) => void;
  /** Fired when a budget threshold is crossed (warning, downgrade, or pause). */
  onBudgetCheck?: (result: BudgetCheckResult) => void;
  /** Auditor runners to evaluate each assistant response before delivery. */
  auditors?: AuditorRunner[];
  /** Fired after auditors evaluate a response. */
  onAuditorGate?: (decision: AuditorGateDecision) => void;
  /** AbortSignal for cancelling the agent run (used by Ralph Wiggum Loop). */
  abortSignal?: AbortSignal;
}

/**
 * One LLM round-trip's model-latency / tool-execution split.
 *
 * modelLatencyMs and toolExecMs are measured separately and never overlap: the
 * model call and the tool execution it triggers are sequential, not
 * concurrent, so summing both across all iterations accounts for the full run
 * — there is no third bucket of unaccounted time.
 */
export interface IterationTiming {
  iteration: number;
  modelLatencyMs: number;
  toolExecMs: number;
  toolCalls: { name: string; resultBytes: number; isError: boolean }[];
}

export interface AgentRunResult {
  finalResponse: string;
  toolCallCount: number;
  iterations: number;
  usage: TokenUsage;
  /** Full message array at end of run, including history + this turn's exchanges. */
  messages: Message[];
  /** Per-iteration model/tool timing split — see IterationTiming. */
  timings: IterationTiming[];
}

export interface PlanStep {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  result?: string;
  error?: string;
}
