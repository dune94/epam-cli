import type { Tool, ToolResult } from '../tools/types.js';
import type { LLMProvider } from '../providers/types.js';
import { AgentRunner } from './AgentRunner.js';

interface HandoffOptions {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  dangerousSkipApproval: boolean;
  maxOutputTokens?: number;
  onTextDelta?: (delta: string) => void;
}

export class AgentHandoffTool implements Tool {
  readonly name = 'delegate_to_agent';
  readonly description =
    'Delegate a sub-task to a child agent. The child agent will execute the task and return the result.';
  readonly permission = 'safe' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: 'The task description for the child agent to execute',
        },
        context: {
          type: 'string',
          description: 'Additional context to provide to the child agent',
        },
      },
      required: ['task'],
    },
  };

  constructor(private options: HandoffOptions) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const task = input.task as string;
    const context = input.context as string | undefined;

    const userMessage = context ? `Context: ${context}\n\nTask: ${task}` : task;

    try {
      const runner = new AgentRunner({
        userMessage,
        systemPrompt: this.options.systemPrompt,
        provider: this.options.provider,
        model: this.options.model,
        tools: this.options.tools.filter(t => t.name !== 'delegate_to_agent'),
        maxIterations: 10,
        dangerousSkipApproval: this.options.dangerousSkipApproval,
        maxOutputTokens: this.options.maxOutputTokens,
        onTextDelta: this.options.onTextDelta,
      });

      const result = await runner.run();
      return { toolUseId: '', content: result.finalResponse, isError: false };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Delegated agent failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
