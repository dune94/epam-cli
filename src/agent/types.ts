import type { LLMProvider, TokenUsage } from '../providers/types.js';
import type { Tool } from '../tools/types.js';

export interface AgentRunOptions {
  userMessage: string;
  systemPrompt: string;
  provider: LLMProvider;
  model: string;
  tools: Tool[];
  maxIterations?: number;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, result: string, isError: boolean) => void;
  onIterationStart?: (iteration: number) => void;
}

export interface AgentRunResult {
  finalResponse: string;
  toolCallCount: number;
  iterations: number;
  usage: TokenUsage;
}

export interface PlanStep {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  result?: string;
  error?: string;
}

export interface AgentContextEntry {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  toolCallId?: string;
  toolName?: string;
  timestamp: number;
}
