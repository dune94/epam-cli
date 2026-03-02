import type { Message } from '../providers/types.js';
import type { FileChange } from './FileSystemSnapshot.js';

/**
 * Strategy hints given to parallel Ralph Wiggum Loop agents.
 * Each agent receives a different approach suggestion for fixing the error.
 */
export type FixStrategy =
  | 'minimal_change'      // Strategy 1: Make the smallest possible fix
  | 'refactor_approach'   // Strategy 2: Refactor the problematic approach
  | 'alternative_impl'    // Strategy 3: Use an alternative implementation
  | 'dependency_fix'      // Strategy 4: Check/fix dependency issues
  | 'configuration_fix';  // Strategy 5: Check/fix configuration issues

/**
 * Input to the Ralph Wiggum Loop error recovery system.
 */
export interface RalphWiggumInput {
  /** The original bash command that failed */
  command: string;
  /** The stderr output from the failed command */
  stderr: string;
  /** The full stdout output (may contain partial results) */
  stdout: string;
  /** The exit code from the failed command */
  exitCode: number;
  /** The conversation context messages up to the point of failure */
  contextMessages: Message[];
  /** The system prompt being used */
  systemPrompt: string;
  /** Files that may have been modified and need snapshotting for rollback */
  filesToSnapshot?: string[];
}

/**
 * Result from a single Ralph Wiggum Loop agent attempt.
 */
export interface RalphWiggumAttempt {
  /** The strategy this agent was assigned */
  strategy: FixStrategy;
  /** Whether the fix succeeded (command passed on re-run) */
  success: boolean;
  /** The fix that was applied (diff or description) */
  fixDescription: string;
  /** Token count of the fix (for quality scoring) */
  tokenCount: number;
  /** The full agent run result messages */
  messages: Message[];
  /** Whether this attempt was cancelled */
  cancelled: boolean;
  /** File changes made by this agent (for explicit fix application) */
  fileChanges?: FileChange[];
  /** Diff token count for quality scoring (more accurate than response tokens) */
  diffTokenCount?: number;
}

/**
 * Quality score for a Ralph Wiggum Loop fix.
 * Lower scores are better (prefer simpler fixes).
 */
export interface QualityScore {
  /** The attempt being scored */
  attempt: RalphWiggumAttempt;
  /** Whether the original command passes with this fix */
  commandPasses: boolean;
  /** Token count of the fix diff (actual code changes) */
  diffTokenCount: number;
  /** Computed quality score (lower is better) */
  score: number;
  /** Ranking position (1 = best) */
  rank?: number;
}

/**
 * Final result from the Ralph Wiggum Loop.
 */
export interface RalphWiggumResult {
  /** Whether a successful fix was found */
  success: boolean;
  /** The winning attempt (best quality score among successful fixes) */
  winningAttempt?: RalphWiggumAttempt;
  /** All attempts that were made (including cancelled ones) */
  allAttempts: RalphWiggumAttempt[];
  /** Quality scores for all successful attempts */
  qualityScores: QualityScore[];
  /** Total time spent in the loop (ms) */
  elapsedMs: number;
  /** Number of parallel agents spawned */
  agentsSpawned: number;
  /** Number of agents cancelled before completion */
  agentsCancelled: number;
}

/**
 * Configuration for Ralph Wiggum Loop execution.
 */
export interface RalphWiggumConfig {
  /** Number of parallel agents to spawn (default: 3) */
  parallelAgents: number;
  /** Timeout for each agent in ms (default: 120000 = 2 min) */
  agentTimeout: number;
  /** Whether to re-run the original command to verify fixes (default: true) */
  verifyFix: boolean;
  /** Available fix strategies to distribute among agents */
  strategies: FixStrategy[];
}

/**
 * Default configuration for Ralph Wiggum Loop.
 */
export const DEFAULT_RALPH_WIGGUM_CONFIG: RalphWiggumConfig = {
  parallelAgents: 3,
  agentTimeout: 120000,
  verifyFix: true,
  strategies: ['minimal_change', 'refactor_approach', 'alternative_impl'],
};

/**
 * Strategy hint descriptions for system prompt injection.
 */
export const STRATEGY_DESCRIPTIONS: Record<FixStrategy, string> = {
  minimal_change:
    'Strategy 1: Minimal Change — Make the smallest possible fix. Change only what is absolutely necessary to resolve the error. Prefer targeted edits over refactoring.',
  refactor_approach:
    'Strategy 2: Refactor Approach — The current approach has issues. Refactor the problematic code with a cleaner design. Consider breaking into smaller functions or using different patterns.',
  alternative_impl:
    'Strategy 3: Alternative Implementation — Abandon the current approach entirely. Implement the functionality using a completely different method or library.',
  dependency_fix:
    'Strategy 4: Dependency Fix — The error may be caused by missing or misconfigured dependencies. Check package.json, imports, and installation status. Install or update packages as needed.',
  configuration_fix:
    'Strategy 5: Configuration Fix — The error may be caused by incorrect configuration. Check environment variables, config files, paths, and build settings.',
};
