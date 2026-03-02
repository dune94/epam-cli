import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';

/**
 * Represents a snapshot of a single file's contents.
 */
export interface FileSnapshot {
  /** Absolute file path */
  path: string;
  /** File contents at snapshot time */
  content: string;
  /** Whether the file existed at snapshot time */
  existed: boolean;
  /** Timestamp when snapshot was taken */
  timestamp: number;
}

/**
 * Represents a file change made by a Ralph Wiggum Loop agent.
 */
export interface FileChange {
  /** Absolute file path */
  path: string;
  /** Original content before the change */
  before: string;
  /** New content after the change */
  after: string;
  /** Whether this is a new file */
  isNewFile: boolean;
  /** Whether this file was deleted */
  isDeletion: boolean;
}

/**
 * FileSystemSnapshot: Captures and restores file system state.
 *
 * Used by Ralph Wiggum Loop to safely apply parallel agent fixes
 * and rollback losing attempts.
 */
export class FileSystemSnapshot {
  private snapshots: Map<string, FileSnapshot> = new Map();
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * Capture snapshots of the specified files.
   *
   * @param paths - Absolute or relative file paths to snapshot
   */
  async capture(paths: string[]): Promise<void> {
    logger.debug({ pathCount: paths.length }, 'FileSystemSnapshot: Capturing files');

    for (const relativePath of paths) {
      const absolutePath = this.toAbsolutePath(relativePath);
      await this.captureFile(absolutePath);
    }
  }

  /**
   * Capture a single file's contents.
   */
  private async captureFile(absolutePath: string): Promise<void> {
    try {
      const existed = existsSync(absolutePath);
      const content = existed ? await readFile(absolutePath, 'utf-8') : '';

      this.snapshots.set(absolutePath, {
        path: absolutePath,
        content,
        existed,
        timestamp: Date.now(),
      });

      logger.debug({ path: absolutePath, existed, size: content.length },
        'FileSystemSnapshot: Captured file');
    } catch (err) {
      logger.warn({ path: absolutePath, error: (err as Error).message },
        'FileSystemSnapshot: Failed to capture file');
    }
  }

  /**
   * Restore all captured files to their original state.
   *
   * @returns Array of paths that were restored
   */
  async restore(): Promise<string[]> {
    logger.debug({ snapshotCount: this.snapshots.size }, 'FileSystemSnapshot: Restoring files');

    const restored: string[] = [];

    for (const [path, snapshot] of this.snapshots.entries()) {
      try {
        if (snapshot.existed) {
          // Restore original content
          await writeFile(path, snapshot.content, 'utf-8');
        } else {
          // File didn't exist - delete it if it was created
          if (existsSync(path)) {
            const { unlink } = await import('fs/promises');
            await unlink(path);
          }
        }
        restored.push(path);
        logger.debug({ path }, 'FileSystemSnapshot: Restored file');
      } catch (err) {
        logger.error({ path, error: (err as Error).message },
          'FileSystemSnapshot: Failed to restore file');
      }
    }

    return restored;
  }

  /**
   * Get the snapshot for a specific file.
   */
  getSnapshot(path: string): FileSnapshot | undefined {
    const absolutePath = this.toAbsolutePath(path);
    return this.snapshots.get(absolutePath);
  }

  /**
   * Get all captured paths.
   */
  getCapturedPaths(): string[] {
    return Array.from(this.snapshots.keys());
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots.clear();
  }

  /**
   * Record a file change made by an agent.
   *
   * @param path - File path that was changed
   * @param before - Content before the change
   * @param after - Content after the change
   * @returns The recorded FileChange
   */
  recordChange(path: string, before: string, after: string): FileChange {
    const absolutePath = this.toAbsolutePath(path);
    const originalSnapshot = this.snapshots.get(absolutePath);
    const isNewFile = !originalSnapshot?.existed;
    const isDeletion = after === '' && originalSnapshot?.existed === true;

    const change: FileChange = {
      path: absolutePath,
      before,
      after,
      isNewFile,
      isDeletion,
    };

    logger.debug({
      path: absolutePath,
      isNewFile,
      isDeletion,
      beforeSize: before.length,
      afterSize: after.length,
    }, 'FileSystemSnapshot: Recorded change');

    return change;
  }

  /**
   * Apply a file change and return a rollback function.
   *
   * @param change - The change to apply
   * @returns Function that will rollback this change when called
   */
  async applyChange(change: FileChange): Promise<() => Promise<void>> {
    const absolutePath = this.toAbsolutePath(change.path);

    // Save current state for rollback
    const currentState = existsSync(absolutePath)
      ? await readFile(absolutePath, 'utf-8')
      : '';
    const existedBeforeApply = existsSync(absolutePath);

    // Apply the change
    if (change.isDeletion) {
      const { unlink } = await import('fs/promises');
      try {
        await unlink(absolutePath);
      } catch (err) {
        logger.warn({ path: absolutePath }, 'FileSystemSnapshot: Failed to delete file');
      }
    } else {
      await writeFile(absolutePath, change.after, 'utf-8');
    }

    logger.debug({ path: absolutePath, isNewFile: change.isNewFile },
      'FileSystemSnapshot: Applied change');

    // Return rollback function
    return async () => {
      if (existedBeforeApply) {
        await writeFile(absolutePath, currentState, 'utf-8');
      } else if (!change.isNewFile && !change.isDeletion) {
        // File didn't exist before, delete it
        const { unlink } = await import('fs/promises');
        await unlink(absolutePath).catch(() => {});
      }
      logger.debug({ path: absolutePath }, 'FileSystemSnapshot: Rolled back change');
    };
  }

  /**
   * Estimate token count for a file change (for quality scoring).
   *
   * @param change - The change to estimate
   * @returns Approximate token count of the diff
   */
  estimateDiffTokens(change: FileChange): number {
    // Simple estimation: count changed characters / 4
    const beforeLines = change.before.split('\n');
    const afterLines = change.after.split('\n');

    // Rough diff estimation: lines that differ
    let changedChars = 0;
    const maxLines = Math.max(beforeLines.length, afterLines.length);

    for (let i = 0; i < maxLines; i++) {
      const beforeLine = beforeLines[i] ?? '';
      const afterLine = afterLines[i] ?? '';
      if (beforeLine !== afterLine) {
        changedChars += beforeLine.length + afterLine.length;
      }
    }

    // Add cost for new/deleted files
    if (change.isNewFile) {
      changedChars += change.after.length;
    }
    if (change.isDeletion) {
      changedChars += change.before.length;
    }

    return Math.ceil(changedChars / 4);
  }

  /**
   * Convert relative path to absolute path.
   */
  private toAbsolutePath(path: string): string {
    if (path.startsWith('/')) {
      return path;
    }
    return `${this.cwd}/${path}`;
  }

  /**
   * Get the total size of all captured content in bytes.
   */
  getTotalSize(): number {
    let total = 0;
    for (const snapshot of this.snapshots.values()) {
      total += snapshot.content.length;
    }
    return total;
  }

  /**
   * Get the number of captured files.
   */
  getSnapshotCount(): number {
    return this.snapshots.size;
  }
}
