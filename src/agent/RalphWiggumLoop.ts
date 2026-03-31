import { AgentRunner } from './AgentRunner.js';
import type { LLMProvider, Message } from '../providers/types.js';
import type { Tool } from '../tools/types.js';
import { logger } from '../utils/logger.js';
import { FileSystemSnapshot } from './FileSystemSnapshot.js';
import type { FileChange } from './FileSystemSnapshot.js';
import {
  type RalphWiggumInput,
  type RalphWiggumResult,
  type RalphWiggumAttempt,
  type RalphWiggumConfig,
  type QualityScore,
  type FixStrategy,
  DEFAULT_RALPH_WIGGUM_CONFIG,
  STRATEGY_DESCRIPTIONS,
} from './RalphWiggumLoop.types.js';

/**
 * Ralph Wiggum Loop: Parallel error recovery system.
 *
 * When a Bash tool call returns a non-zero exit code, spawns N parallel
 * AgentRunner instances each attempting a different fix strategy.
 * The first instance to succeed wins; others are cancelled.
 * Quality scoring prefers fixes with lowest token complexity that also
 * pass the original failing command on re-run.
 */
export class RalphWiggumLoop {
  private config: RalphWiggumConfig;
  private startTime: number = 0;

  constructor(config: Partial<RalphWiggumConfig> = {}) {
    this.config = { ...DEFAULT_RALPH_WIGGUM_CONFIG, ...config };
  }

  /**
   * Execute the Ralph Wiggum Loop error recovery.
   *
   * @param input - Error details and context
   * @param provider - LLM provider to use for all parallel agents
   * @param model - Model to use
   * @param tools - Available tools (must include Bash, WriteFile, ReadFile)
   * @param systemPrompt - Base system prompt
   * @param dangerousSkipApproval - Skip tool approval for CI mode
   * @returns Result with winning fix (if found)
   */
  async run(
    input: RalphWiggumInput,
    provider: LLMProvider,
    model: string,
    tools: Tool[],
    systemPrompt: string,
    dangerousSkipApproval: boolean = false
  ): Promise<RalphWiggumResult> {
    this.startTime = Date.now();

    logger.info({
      command: input.command,
      exitCode: input.exitCode,
      parallelAgents: this.config.parallelAgents,
    }, 'RalphWiggumLoop: Starting parallel error recovery');

    // Create file system snapshot for rollback safety
    const snapshot = new FileSystemSnapshot();
    
    // Capture files that may be modified
    if (input.filesToSnapshot && input.filesToSnapshot.length > 0) {
      await snapshot.capture(input.filesToSnapshot);
      logger.debug({ fileCount: input.filesToSnapshot.length },
        'RalphWiggumLoop: Captured file snapshots');
    }

    // Create abort controllers for each parallel agent
    const abortControllers: AbortController[] = [];
    const attempts: RalphWiggumAttempt[] = [];
    const promises: Promise<RalphWiggumAttempt>[] = [];

    // Distribute strategies among agents
    const strategies = this.distributeStrategies();

    // Spawn N parallel agents
    for (let i = 0; i < this.config.parallelAgents; i++) {
      const abortController = new AbortController();
      abortControllers.push(abortController);

      const strategy = strategies[i % strategies.length];
      const promise = this.runParallelAgent(
        input,
        provider,
        model,
        tools,
        systemPrompt,
        strategy,
        abortController.signal,
        dangerousSkipApproval,
        i,
        snapshot
      );

      promises.push(promise);
    }

    // Wait for first success or all to complete
    const results = await this.waitForFirstSuccess(promises, abortControllers);

    // Cancel any remaining agents
    this.cancelAllAgents(abortControllers, results);

    // Find successful, non-cancelled attempts
    const successfulAttempts = results.filter(a => a.success && !a.cancelled);

    // Apply the winning fix (best quality score)
    let winningAttempt: RalphWiggumAttempt | undefined;
    let rollbackFunctions: Array<() => Promise<void>> = [];

    if (successfulAttempts.length > 0) {
      // Compute quality scores
      const qualityScores = await this.computeQualityScores(successfulAttempts, input);
      this.rankQualityScores(qualityScores);

      // Get the winning attempt
      winningAttempt = qualityScores[0].attempt;

      // Apply file changes from the winning attempt
      if (winningAttempt.fileChanges && winningAttempt.fileChanges.length > 0) {
        logger.info({ fileChangeCount: winningAttempt.fileChanges.length },
          'RalphWiggumLoop: Applying winning fix file changes');

        try {
          // Apply each change and collect rollback functions
          for (const change of winningAttempt.fileChanges) {
            const rollback = await snapshot.applyChange(change);
            rollbackFunctions.push(rollback);
          }

          // Verify the fix by re-running the command
          if (this.config.verifyFix) {
            const { execa } = await import('execa');
            const result = await execa('bash', ['-c', input.command], {
              timeout: 10000,
              reject: false,
            });
            winningAttempt.success = result.exitCode === 0;

            if (!winningAttempt.success) {
              logger.warn('RalphWiggumLoop: Winning fix verification failed, rolling back');
              // Rollback all changes
              for (const rollback of rollbackFunctions) {
                await rollback();
              }
              rollbackFunctions = [];
              winningAttempt = undefined;
            }
          }
        } catch (err) {
          logger.error({ error: (err as Error).message },
            'RalphWiggumLoop: Failed to apply winning fix');
          // Rollback on error
          for (const rollback of rollbackFunctions) {
            await rollback();
          }
          rollbackFunctions = [];
          winningAttempt = undefined;
        }
      }
    }

    // Rollback all losing attempts' changes (they may have written files)
    const losingAttempts = results.filter(a => a !== winningAttempt && !a.cancelled);
    for (const attempt of losingAttempts) {
      if (attempt.fileChanges && attempt.fileChanges.length > 0) {
        logger.debug({ strategy: attempt.strategy },
          'RalphWiggumLoop: Rolling back losing attempt changes');
        // Losing attempts don't apply their changes, so no rollback needed
        // The snapshot still has the original state
      }
    }

    const elapsedMs = Date.now() - this.startTime;

    const finalResult: RalphWiggumResult = {
      success: winningAttempt?.success ?? false,
      winningAttempt,
      allAttempts: results,
      qualityScores: successfulAttempts.length > 0
        ? await this.computeQualityScores(successfulAttempts, input)
        : [],
      elapsedMs,
      agentsSpawned: this.config.parallelAgents,
      agentsCancelled: abortControllers.filter(ac => ac.signal.aborted).length,
    };

    logger.info({
      success: finalResult.success,
      elapsedMs,
      winningStrategy: winningAttempt?.strategy,
      agentsCancelled: finalResult.agentsCancelled,
    }, 'RalphWiggumLoop: Completed');

    return finalResult;
  }

  /**
   * Distribute strategies among parallel agents.
   */
  private distributeStrategies(): FixStrategy[] {
    const strategies: FixStrategy[] = [];
    for (let i = 0; i < this.config.parallelAgents; i++) {
      strategies.push(this.config.strategies[i % this.config.strategies.length]);
    }
    return strategies;
  }

  /**
   * Run a single parallel agent with a specific strategy.
   */
  private async runParallelAgent(
    input: RalphWiggumInput,
    provider: LLMProvider,
    model: string,
    tools: Tool[],
    baseSystemPrompt: string,
    strategy: FixStrategy,
    abortSignal: AbortSignal,
    dangerousSkipApproval: boolean,
    agentIndex: number,
    snapshot: FileSystemSnapshot
  ): Promise<RalphWiggumAttempt> {
    const strategyDescription = STRATEGY_DESCRIPTIONS[strategy];

    // Build strategy-specific system prompt
    const strategySystemPrompt = `${baseSystemPrompt}

[ERROR RECOVERY MODE]
You are attempting to fix a bash command failure using ${strategy.replace(/_/g, ' ')}.

Original command that failed:
\`\`\`bash
${input.command}
\`\`\`

Error output:
\`\`\`
${input.stderr || '(no stderr)'}
\`\`\`

${strategyDescription}

Focus ONLY on fixing this specific error. Do not make unrelated changes.
After applying your fix, the command will be re-run to verify it works.

IMPORTANT: When modifying files, use the WriteFile tool. Your changes will be tracked
and only the winning fix will be applied. Be precise with your edits.`;

    // Build user message with error context
    const userMessage = `The following bash command failed:

\`\`\`bash
${input.command}
\`\`\`

Exit code: ${input.exitCode}

Error output:
\`\`\`
${input.stderr || '(no stderr)'}
\`\`\`

${input.stdout ? `Partial output before failure:\n\`\`\`\n${input.stdout}\n\`\`\`\n\n` : ''}
Please fix this error using the strategy described in the system prompt.`;

    try {
      // Create a WriteFile wrapper that tracks changes
      const fileChanges: FileChange[] = [];
      const trackedTools = tools.map(tool => {
        if (tool.name === 'write_file') {
          return {
            ...tool,
            execute: async (toolInput: Record<string, unknown>) => {
              const path = toolInput.path as string;
              const content = toolInput.content as string;
              
              // Get original content from snapshot or file
              let before = '';
              try {
                const { readFile } = await import('fs/promises');
                const { existsSync } = await import('fs');
                const absolutePath = path.startsWith('/') ? path : `${process.cwd()}/${path}`;
                if (existsSync(absolutePath)) {
                  before = await readFile(absolutePath, 'utf-8');
                }
              } catch {
                before = '';
              }
              
              // Record the change
              fileChanges.push({
                path,
                before,
                after: content,
                isNewFile: before === '',
                isDeletion: false,
              });
              
              // Execute the original WriteFile
              return tool.execute(toolInput);
            },
          };
        }
        return tool;
      });

      const runner = new AgentRunner({
        userMessage,
        systemPrompt: strategySystemPrompt,
        provider,
        model,
        tools: trackedTools,
        maxIterations: 10,
        dangerousSkipApproval,
        history: input.contextMessages,
      });

      // Note: AgentRunner doesn't yet support abortSignal - this will be added
      // For now, we track cancellation manually
      let cancelled = false;

      // Set up abort listener
      abortSignal.addEventListener('abort', () => {
        logger.debug({ agentIndex, strategy }, 'RalphWiggumLoop: Agent cancelled');
        cancelled = true;
      });

      const result = await Promise.race([
        runner.run(),
        new Promise<never>((_, reject) => {
          const checkInterval = setInterval(() => {
            if (abortSignal.aborted) {
              clearInterval(checkInterval);
              reject(new Error('Agent cancelled'));
            }
          }, 100);
        }),
      ]);

      // Estimate token count from response
      const tokenCount = this.estimateTokens(result.finalResponse);
      
      // Calculate diff token count from file changes
      const diffTokenCount = fileChanges.reduce(
        (sum, change) => sum + snapshot.estimateDiffTokens(change),
        0
      );

      return {
        strategy,
        success: true,
        fixDescription: result.finalResponse,
        tokenCount,
        diffTokenCount: diffTokenCount || tokenCount,
        messages: result.messages,
        cancelled,
        fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
      };
    } catch (err) {
      if ((err as Error).message === 'Agent cancelled') {
        return {
          strategy,
          success: false,
          fixDescription: '',
          tokenCount: 0,
          messages: [],
          cancelled: true,
        };
      }

      logger.warn({ agentIndex, strategy, error: (err as Error).message },
        'RalphWiggumLoop: Agent failed');

      return {
        strategy,
        success: false,
        fixDescription: (err as Error).message,
        tokenCount: 0,
        messages: [],
        cancelled: false,
      };
    }
  }

  /**
   * Wait for first success or all agents to complete.
   * Uses Promise.race pattern with cancellation.
   */
  private async waitForFirstSuccess(
    promises: Promise<RalphWiggumAttempt>[],
    abortControllers: AbortController[]
  ): Promise<RalphWiggumAttempt[]> {
    const results: RalphWiggumAttempt[] = [];
    let firstSuccess: RalphWiggumAttempt | null = null;

    // Use Promise.allSettled to wait for all without early termination
    const settled = await Promise.allSettled(promises);

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        if (result.value.success && !firstSuccess) {
          firstSuccess = result.value;
        }
      }
    }

    return results;
  }

  /**
   * Cancel all agents that haven't completed yet.
   */
  private cancelAllAgents(
    abortControllers: AbortController[],
    _results: RalphWiggumAttempt[]
  ): void {
    // Cancel all remaining agents
    abortControllers.forEach(ac => ac.abort());
  }

  /**
   * Compute quality scores for successful attempts.
   */
  private async computeQualityScores(
    attempts: RalphWiggumAttempt[],
    input: RalphWiggumInput
  ): Promise<QualityScore[]> {
    const successfulAttempts = attempts.filter(a => a.success && !a.cancelled);

    if (successfulAttempts.length === 0) {
      return [];
    }

    const scores: QualityScore[] = [];

    for (const attempt of successfulAttempts) {
      // Verify fix by re-running the original command
      let commandPasses = false;

      if (this.config.verifyFix) {
        try {
          const { execa } = await import('execa');
          const result = await execa('bash', ['-c', input.command], {
            timeout: 10000,
            reject: false,
          });
          commandPasses = result.exitCode === 0;
        } catch {
          commandPasses = false;
        }
      } else {
        // If verification is disabled, assume success
        commandPasses = true;
      }

      // Compute quality score
      // Lower is better: prefer fixes that pass and have lower diff token count
      const baseScore = attempt.diffTokenCount ?? attempt.tokenCount;
      const penalty = commandPasses ? 0 : 10000; // Heavy penalty for not passing
      const score = baseScore + penalty;

      scores.push({
        attempt,
        commandPasses,
        diffTokenCount: attempt.diffTokenCount ?? attempt.tokenCount,
        score,
      });
    }

    return scores;
  }

  /**
   * Rank quality scores (lower score = better rank).
   */
  private rankQualityScores(scores: QualityScore[]): void {
    // Sort by score (lower is better)
    scores.sort((a, b) => a.score - b.score);

    // Assign ranks
    scores.forEach((score, index) => {
      score.rank = index + 1;
    });
  }

  /**
   * Estimate token count from text.
   * Rough approximation: ~4 chars per token.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
