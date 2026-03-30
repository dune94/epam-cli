import type { ToolResult, ToolCallRequest } from '../tools/types.js';
import { requestApproval } from '../tools/approval/ApprovalGate.js';
import { pLimit } from '../utils/semaphore.js';
import { logger } from '../utils/logger.js';
import type { ToolRunner } from './tools/ToolRunner.js';

interface ExecutorOptions {
  toolRunner: ToolRunner;
  maxConcurrency: number;
}

export class Executor {
  constructor(private options: ExecutorOptions) {}

  async executeAll(requests: ToolCallRequest[]): Promise<ToolResult[]> {
    const tasks = requests.map(req => () => this.executeSingle(req));
    return pLimit(tasks, this.options.maxConcurrency);
  }

  private async executeSingle(request: ToolCallRequest): Promise<ToolResult> {
    const states = this.options.toolRunner.getAllToolStates();
    const toolState = states.find(s => s.tool.name === request.name);

    if (!toolState) {
      return {
        toolUseId: request.id,
        content: `Tool '${request.name}' not found`,
        isError: true,
      };
    }

    const { tool, safetyTier: permission, approvalMode } = toolState;

    if (approvalMode === 'disabled') {
      return {
        toolUseId: request.id,
        content: `Tool '${tool.name}' is disabled by user permission overrides`,
        isError: true,
      };
    }

    let approved = approvalMode === 'auto';
    
    if (!approved) {
      // Prompt user
      approved = await requestApproval(
        tool.name,
        request.input,
        permission,
        false // dangerousSkipApproval is superseded by ToolRunner's auto mode
      );
    }

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
