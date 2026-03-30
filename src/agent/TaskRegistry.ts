import { ulid } from 'ulid';

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  startedAt: number;
  resolvedAt?: number;
  result?: string;
  error?: string;
  abortController?: AbortController;
}

/**
 * Singleton registry for tracking background async tasks in the current session
 * (e.g., parallel squad sub-agents, background tool executions)
 */
class TaskRegistryImpl {
  private tasks: Map<string, Task> = new Map();

  /**
   * Register a new background task
   */
  register(description: string, abortController?: AbortController): string {
    const id = ulid();
    const task: Task = {
      id,
      description,
      status: 'running',
      startedAt: Date.now(),
      abortController,
    };
    this.tasks.set(id, task);
    return id;
  }

  /**
   * Mark a task as done with optional result summary
   */
  markDone(id: string, result?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'done';
    task.resolvedAt = Date.now();
    task.result = result;
  }

  /**
   * Mark a task as failed with optional error message
   */
  markFailed(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'failed';
    task.resolvedAt = Date.now();
    task.error = error;
  }

  /**
   * Cancel a task and call AbortController.abort() if registered
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return false;

    task.status = 'cancelled';
    task.resolvedAt = Date.now();
    task.abortController?.abort();
    return true;
  }

  /**
   * Get a task by ID
   */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all tasks
   */
  getAll(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Find task by prefix (for short ID lookups)
   */
  findByPrefix(prefix: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.id.startsWith(prefix)) {
        return task;
      }
    }
    return undefined;
  }

  /**
   * Clear all tasks (typically on session reset)
   */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * Wait for a task to complete (resolve or reject)
   */
  async await(id: string): Promise<{ status: TaskStatus; result?: string; error?: string }> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    if (task.status !== 'running') {
      return { status: task.status, result: task.result, error: task.error };
    }

    // Poll for completion (simple approach; in a real system might use events)
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const current = this.tasks.get(id);
        if (current && current.status !== 'running') {
          clearInterval(interval);
          resolve({
            status: current.status,
            result: current.result,
            error: current.error,
          });
        }
      }, 100);
    });
  }
}

// Singleton instance
export const TaskRegistry = new TaskRegistryImpl();
