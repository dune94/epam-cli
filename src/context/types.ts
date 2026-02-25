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
