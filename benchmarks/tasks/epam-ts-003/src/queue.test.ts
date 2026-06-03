import { describe, it, expect } from 'vitest';
import { Queue } from './queue';

describe('Queue', () => {
  it('enqueue adds items to the queue', () => {
    const q = new Queue<number>();
    q.enqueue(1);
    q.enqueue(2);
    expect(q.size).toBe(2);
  });

  it('size returns correct count', () => {
    const q = new Queue<string>();
    expect(q.size).toBe(0);
    q.enqueue('a');
    expect(q.size).toBe(1);
  });

  it('drain returns items in FIFO order', () => {
    const q = new Queue<number>();
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    expect(q.drain()).toEqual([1, 2, 3]);
  });

  it('drain empties the queue', () => {
    const q = new Queue<number>();
    q.enqueue(42);
    q.drain();
    expect(q.size).toBe(0);
  });
});
