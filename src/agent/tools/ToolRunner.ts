import type { Tool, ToolPermission } from '../../tools/types.js';
import { classifyTool } from '../../tools/approval/SafetyPolicy.js';

export type ApprovalMode = 'auto' | 'prompt' | 'disabled';

interface ToolApprovalState {
  tool: Tool;
  safetyTier: ToolPermission;
  approvalMode: ApprovalMode;
}

export class ToolRunner {
  private toolOverrides = new Map<string, ApprovalMode>();
  private globalAutoApprove = false;
  private originalDangerousSkipApproval: boolean;

  constructor(
    private tools: Tool[],
    dangerousSkipApproval: boolean
  ) {
    this.originalDangerousSkipApproval = dangerousSkipApproval;
    this.globalAutoApprove = dangerousSkipApproval;
  }

  /**
   * Replace the active tool list while preserving current approval overrides where possible.
   */
  setTools(tools: Tool[]): void {
    const names = new Set(tools.map(tool => tool.name));
    for (const name of this.toolOverrides.keys()) {
      if (!names.has(name)) {
        this.toolOverrides.delete(name);
      }
    }
    this.tools = tools;
  }

  /**
   * Get all tools with their current approval state.
   */
  getAllToolStates(): ToolApprovalState[] {
    return this.tools.map(tool => ({
      tool,
      safetyTier: classifyTool(tool.name, tool.permission),
      approvalMode: this.getApprovalMode(tool.name, tool.permission),
    }));
  }

  /**
   * Get the current approval mode for a specific tool.
   */
  getApprovalMode(toolName: string, permission: ToolPermission): ApprovalMode {
    // Check for per-tool override first
    const override = this.toolOverrides.get(toolName);
    if (override) return override;

    // If global auto-approve is enabled
    if (this.globalAutoApprove) return 'auto';

    // Default: safe tools auto-approve, others prompt
    const classified = classifyTool(toolName, permission);
    return classified === 'safe' ? 'auto' : 'prompt';
  }

  /**
   * Set approval mode for a specific tool.
   */
  setToolApprovalMode(toolName: string, mode: ApprovalMode): void {
    this.toolOverrides.set(toolName, mode);
  }

  /**
   * Enable auto-approve for all tools (equivalent to EPAM_DANGEROUS_SKIP_APPROVAL=1).
   */
  setAutoApproveAll(): void {
    this.globalAutoApprove = true;
  }

  /**
   * Reset to original approval policy (from config/env).
   */
  reset(): void {
    this.toolOverrides.clear();
    this.globalAutoApprove = this.originalDangerousSkipApproval;
  }

  /**
   * Check if a tool should be auto-approved (for use by ApprovalGate).
   */
  shouldAutoApprove(toolName: string, permission: ToolPermission): boolean {
    const mode = this.getApprovalMode(toolName, permission);
    return mode === 'auto';
  }

  /**
   * Check if a tool is disabled.
   */
  isDisabled(toolName: string, permission: ToolPermission): boolean {
    const mode = this.getApprovalMode(toolName, permission);
    return mode === 'disabled';
  }

  /**
   * Check if global auto-approve is enabled.
   */
  isGlobalAutoApprove(): boolean {
    return this.globalAutoApprove;
  }
}
