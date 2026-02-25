import type { Message } from '../providers/types.js';
import type { AgentContextEntry, AgentRunOptions } from './types.js';

export class AgentContext {
  private entries: AgentContextEntry[] = [];
  private tokenCount = 0;

  constructor(
    private readonly systemPrompt: string,
    private readonly autoCompressAt: number = 80000
  ) {}

  addUserMessage(content: string): void {
    this.entries.push({
      role: 'user',
      content,
      timestamp: Date.now(),
    });
  }

  addAssistantMessage(content: string): void {
    this.entries.push({
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }

  addToolResult(toolCallId: string, toolName: string, result: string): void {
    this.entries.push({
      role: 'tool_result',
      content: result,
      toolCallId,
      toolName,
      timestamp: Date.now(),
    });
  }

  buildMessages(initialUserMessage: string): Message[] {
    const messages: Message[] = [];

    // Add initial user message if this is the start
    if (this.entries.length === 0) {
      messages.push({ role: 'user', content: initialUserMessage });
      return messages;
    }

    // Build messages from context entries
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      if (entry.role === 'user') {
        messages.push({ role: 'user', content: entry.content });
      } else if (entry.role === 'assistant') {
        messages.push({ role: 'assistant', content: entry.content });
      } else if (entry.role === 'tool_result') {
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_use_id: entry.toolCallId ?? '',
              content: entry.content,
            },
          ],
        });
      }
    }

    return messages;
  }

  estimateTokenCount(): number {
    return this.entries.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
  }

  shouldCompress(): boolean {
    return this.estimateTokenCount() > this.autoCompressAt;
  }

  clear(): void {
    this.entries = [];
    this.tokenCount = 0;
  }

  getEntries(): AgentContextEntry[] {
    return [...this.entries];
  }
}
