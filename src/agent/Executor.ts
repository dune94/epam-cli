import type { Tool, ToolResult, ToolCallRequest } from '../tools/types.js';
import { requestApproval } from '../tools/approval/ApprovalGate.js';
import { pLimit } from '../utils/semaphore.js';
import { logger } from '../utils/logger.js';

interface ExecutorOptions {
  tools: Tool[];
  dangerousSkipApproval: boolean;
  maxConcurrency: number;
}

export class Executor {
  private toolMap: Map<string, Tool>;

  constructor(private options: ExecutorOptions) {
    this.toolMap = new Map(options.tools.map(t => [t.name, t]));
  }

  async executeAll(requests: ToolCallRequest[]): Promise<ToolResult[]> {
    const tasks = requests.map(req => () => this.executeSingle(req));
    return pLimit(tasks, this.options.maxConcurrency);
  }

  private async executeSingle(request: ToolCallRequest): Promise<ToolResult> {
    const tool = this.toolMap.get(request.name);

    if (!tool) {
      return {
        toolUseId: request.id,
        content: `Tool '${request.name}' not found`,
        isError: true,
      };
    }

    const approved = await requestApproval(
      tool.name,
      request.input,
      tool.permission,
      this.options.dangerousSkipApproval
    );

    if (!approved) {
      return {
        toolUseId: request.id,
        content: `Tool '${tool.name}' was not approved by the user`,
        isError: false,
      };
    }

    try {
      logger.debug({ tool: tool.name, input: request.input }, 'Executing tool');
      const result = await tool.execute(request.input);
      result.toolUseId = request.id;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ tool: tool.name, error: message }, 'Tool execution error');
      return {
        toolUseId: request.id,
        content: `Tool error: ${message}`,
        isError: true,
      };
    }
  }
}
