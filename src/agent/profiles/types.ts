/**
 * Agent profile schema for saving/loading session configurations.
 */
export interface Profile {
  /** Profile identifier (used as filename without extension). */
  name: string;
  /** Human-readable description of the profile's purpose. */
  description: string;
  /** Additional system prompt text to append to the base system prompt. */
  systemPromptAppend?: string;
  /** Tool enable/disable overrides. */
  tools?: {
    enabled?: string[];
    disabled?: string[];
  };
  /** Model override (e.g., "claude-sonnet-4-6"). */
  model?: string;
  /** Max iterations override. */
  maxIterations?: number;
  /** Tags for filtering/categorizing profiles. */
  tags?: string[];
}

/**
 * Profile with its source location (global vs project-local).
 */
export interface ProfileWithSource extends Profile {
  source: 'global' | 'local';
  filePath: string;
}
