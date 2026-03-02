import { execa } from 'execa';
import type { Tool, ToolResult } from '../types.js';

/**
 * Classification of bash command errors for error recovery.
 */
export interface BashErrorClassification {
  /** Whether the error is potentially recoverable */
  recoverable: boolean;
  /** Classification reason/category */
  reason: string;
  /** Suggested fix approach */
  suggestion?: string;
}

/**
 * Extended tool result that includes error classification for Ralph Wiggum Loop.
 */
export interface BashToolResult extends ToolResult {
  /** Exit code from the command (0 = success) */
  exitCode?: number;
  /** Stderr output if any */
  stderr?: string;
  /** Error classification for recovery */
  errorClassification?: BashErrorClassification;
}

export class BashTool implements Tool {
  readonly name = 'bash';
  readonly description =
    'Execute a bash command. Use for running scripts, installing packages, running tests, etc.';
  readonly permission = 'dangerous' as const;

  readonly definition = {
    name: this.name,
    description: this.description,
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (default: current directory)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<BashToolResult> {
    const command = input.command as string;
    const cwd = (input.cwd as string) ?? process.cwd();
    const timeout = (input.timeout as number) ?? 30000;

    try {
      const result = await execa('bash', ['-c', command], {
        cwd,
        timeout,
        all: true,
        reject: false,
      });

      const output = result.all ?? result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.exitCode ?? 0;

      let content = output;
      if (stderr && exitCode !== 0) {
        content += stderr ? `\nSTDERR:\n${stderr}` : '';
      }
      if (exitCode !== 0) {
        content += `\nExit code: ${exitCode}`;
      }

      const isError = exitCode !== 0;
      const errorClassification = isError ? this.classifyError(exitCode, stderr, command) : undefined;

      return {
        toolUseId: '',
        content: content || '(no output)',
        isError,
        exitCode,
        stderr: isError ? stderr : undefined,
        errorClassification,
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error executing command: ${(err as Error).message}`,
        isError: true,
        errorClassification: {
          recoverable: false,
          reason: 'execution_error',
          suggestion: 'Check command syntax and environment',
        },
      };
    }
  }

  /**
   * Classify bash command errors to determine if they are recoverable.
   *
   * Recoverable errors (exit 1/2 with stderr) can be fixed by code changes.
   * Non-recoverable errors (SIGKILL, permission denied) require human intervention.
   */
  classifyError(exitCode: number, stderr: string, command: string): BashErrorClassification {
    const stderrLower = stderr.toLowerCase();

    // Non-recoverable: Signal-based failures (kill, segfault, etc.)
    if (exitCode < 0 || stderrLower.includes('killed') || stderrLower.includes('segfault')) {
      return {
        recoverable: false,
        reason: 'signal_failure',
        suggestion: 'Process was killed or crashed - check resource limits or memory issues',
      };
    }

    // Non-recoverable: Permission denied
    if (stderrLower.includes('permission denied') || stderrLower.includes('eacces')) {
      return {
        recoverable: false,
        reason: 'permission_denied',
        suggestion: 'Requires manual permission fix or sudo',
      };
    }

    // Non-recoverable: Command not found (may need package install)
    if (stderrLower.includes('command not found') || stderrLower.includes('not found')) {
      return {
        recoverable: true,
        reason: 'command_not_found',
        suggestion: 'Install the missing package or check PATH',
      };
    }

    // Non-recoverable: File/directory not found
    if (stderrLower.includes('no such file') || stderrLower.includes('no such directory')) {
      return {
        recoverable: false,
        reason: 'file_not_found',
        suggestion: 'Check file paths and ensure files exist',
      };
    }

    // Recoverable: Exit codes 1-2 typically indicate fixable errors
    if (exitCode === 1 || exitCode === 2) {
      // Check for common fixable patterns
      if (stderrLower.includes('syntax error')) {
        return {
          recoverable: true,
          reason: 'syntax_error',
          suggestion: 'Fix the syntax error in the script or command',
        };
      }

      if (stderrLower.includes('type error') || stderrLower.includes('typeerror')) {
        return {
          recoverable: true,
          reason: 'type_error',
          suggestion: 'Fix the type mismatch',
        };
      }

      if (stderrLower.includes('module not found') || stderrLower.includes('cannot find module')) {
        return {
          recoverable: true,
          reason: 'module_not_found',
          suggestion: 'Install missing dependency or fix import path',
        };
      }

      if (stderrLower.includes('error:')) {
        return {
          recoverable: true,
          reason: 'compilation_error',
          suggestion: 'Fix the compilation/build error',
        };
      }

      // Generic exit 1/2 with stderr - likely fixable
      if (stderr) {
        return {
          recoverable: true,
          reason: 'exit_code_' + exitCode,
          suggestion: 'Review error output and fix the underlying issue',
        };
      }
    }

    // Non-recoverable: High exit codes or unknown errors
    return {
      recoverable: false,
      reason: 'unknown_error_' + exitCode,
      suggestion: 'Unknown error type - may require human intervention',
    };
  }
}
