export class Queue<T> {
  private items: T[] = [];

  enqueue(item: T): void {
    this.items.push(item);
  }

  get size(): number {
    return this.items.length;
  }

  // BUG: pop() removes from end (LIFO); should use shift() for FIFO
  drain(): T[] {
    const result: T[] = [];
    while (this.items.length > 0) {
      result.push(this.items.pop()!);
    }
    return result;
  }
}
