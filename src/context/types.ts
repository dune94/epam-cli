import type { Message } from '../providers/types.js';

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  projectRoot: string | null;
  model: string;
  provider: string;
  turns: SessionTurn[];
}

export interface SessionTurn {
  id: string;
  timestamp: number;
  userMessage: string;
  assistantResponse: string;
  toolCallCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface ForkMetadata {
  type: 'fork_metadata';
  timestamp: number;
  originSessionId: string;
  label?: string;
}

export interface ProjectContext {
  contextMd: string;
  projectRoot: string;
  settings: Record<string, unknown>;
}

export interface ConversationHistory {
  messages: Message[];
  tokenCount: number;
}
