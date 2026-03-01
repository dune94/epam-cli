import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskRegistry, type Task } from '../../../src/agent/TaskRegistry.js';

describe('TaskRegistry', () => {
  beforeEach(() => {
    TaskRegistry.clear();
  });

  describe('task registration', () => {
    it('should register a new task with running status', () => {
      const id = TaskRegistry.register('Test task');
      const task = TaskRegistry.get(id);

      expect(task).toBeDefined();
      expect(task!.description).toBe('Test task');
      expect(task!.status).toBe('running');
      expect(task!.startedAt).toBeGreaterThan(0);
      expect(task!.resolvedAt).toBeUndefined();
    });

    it('should register task with abort controller', () => {
      const abortController = new AbortController();
      const id = TaskRegistry.register('Test task', abortController);
      const task = TaskRegistry.get(id);

      expect(task).toBeDefined();
      expect(task!.abortController).toBe(abortController);
    });

    it('should return unique IDs for multiple tasks', () => {
      const id1 = TaskRegistry.register('Task 1');
      const id2 = TaskRegistry.register('Task 2');

      expect(id1).not.toBe(id2);
    });
  });

  describe('status transitions', () => {
    it('should mark task as done with result', () => {
      const id = TaskRegistry.register('Test task');
      TaskRegistry.markDone(id, 'Success result');

      const task = TaskRegistry.get(id);
      expect(task!.status).toBe('done');
      expect(task!.result).toBe('Success result');
      expect(task!.resolvedAt).toBeGreaterThan(0);
    });

    it('should mark task as failed with error', () => {
      const id = TaskRegistry.register('Test task');
      TaskRegistry.markFailed(id, 'Error message');

      const task = TaskRegistry.get(id);
      expect(task!.status).toBe('failed');
      expect(task!.error).toBe('Error message');
      expect(task!.resolvedAt).toBeGreaterThan(0);
    });

    it('should mark task as cancelled', () => {
      const id = TaskRegistry.register('Test task');
      const cancelled = TaskRegistry.cancel(id);

      expect(cancelled).toBe(true);
      const task = TaskRegistry.get(id);
      expect(task!.status).toBe('cancelled');
      expect(task!.resolvedAt).toBeGreaterThan(0);
    });

    it('should not cancel non-running task', () => {
      const id = TaskRegistry.register('Test task');
      TaskRegistry.markDone(id);

      const cancelled = TaskRegistry.cancel(id);
      expect(cancelled).toBe(false);

      const task = TaskRegistry.get(id);
      expect(task!.status).toBe('done'); // status unchanged
    });
  });

  describe('cancel signal propagation', () => {
    it('should call AbortController.abort() when task is cancelled', () => {
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');

      const id = TaskRegistry.register('Test task', abortController);
      TaskRegistry.cancel(id);

      expect(abortSpy).toHaveBeenCalledOnce();
    });

    it('should handle cancel when no abort controller registered', () => {
      const id = TaskRegistry.register('Test task');
      const cancelled = TaskRegistry.cancel(id);

      expect(cancelled).toBe(true);
      const task = TaskRegistry.get(id);
      expect(task!.status).toBe('cancelled');
    });
  });

  describe('await resolution', () => {
    it('should resolve immediately if task already done', async () => {
      const id = TaskRegistry.register('Test task');
      TaskRegistry.markDone(id, 'Completed');

      const result = await TaskRegistry.await(id);

      expect(result.status).toBe('done');
      expect(result.result).toBe('Completed');
    });

    it('should resolve immediately if task already failed', async () => {
      const id = TaskRegistry.register('Test task');
      TaskRegistry.markFailed(id, 'Error occurred');

      const result = await TaskRegistry.await(id);

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Error occurred');
    });

    it('should wait for task to complete', async () => {
      const id = TaskRegistry.register('Test task');

      // Complete task after 100ms
      setTimeout(() => {
        TaskRegistry.markDone(id, 'Async result');
      }, 100);

      const result = await TaskRegistry.await(id);

      expect(result.status).toBe('done');
      expect(result.result).toBe('Async result');
    });

    it('should throw error if task not found', async () => {
      await expect(TaskRegistry.await('nonexistent-id')).rejects.toThrow(
        'Task nonexistent-id not found'
      );
    });
  });

  describe('task lookup', () => {
    it('should find task by full ID', () => {
      const id = TaskRegistry.register('Test task');
      const task = TaskRegistry.get(id);

      expect(task).toBeDefined();
      expect(task!.id).toBe(id);
    });

    it('should find task by prefix', () => {
      const id = TaskRegistry.register('Test task');
      const prefix = id.slice(0, 8);
      const task = TaskRegistry.findByPrefix(prefix);

      expect(task).toBeDefined();
      expect(task!.id).toBe(id);
    });

    it('should return undefined for unknown prefix', () => {
      TaskRegistry.register('Test task');
      const task = TaskRegistry.findByPrefix('unknown');

      expect(task).toBeUndefined();
    });

    it('should get all tasks', () => {
      const id1 = TaskRegistry.register('Task 1');
      const id2 = TaskRegistry.register('Task 2');

      const tasks = TaskRegistry.getAll();

      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.id)).toContain(id1);
      expect(tasks.map(t => t.id)).toContain(id2);
    });
  });

  describe('table rendering with no tasks', () => {
    it('should return empty array when no tasks registered', () => {
      const tasks = TaskRegistry.getAll();
      expect(tasks).toHaveLength(0);
    });

    it('should clear all tasks', () => {
      TaskRegistry.register('Task 1');
      TaskRegistry.register('Task 2');

      TaskRegistry.clear();

      const tasks = TaskRegistry.getAll();
      expect(tasks).toHaveLength(0);
    });
  });
});
