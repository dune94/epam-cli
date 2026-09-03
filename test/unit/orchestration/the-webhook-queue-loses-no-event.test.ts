/**
 * THE DEBOUNCED WEBHOOK QUEUE — 187 lines, no test.
 *
 * It collapses rapid Jira edits into one orchestration trigger, and it PERSISTS to disk so events
 * survive a control-plane restart. Both of those are places an event can vanish without trace: a
 * dropped event is not an error, it is a run that never happens, and nothing reports it.
 *
 * The failure that matters most is the one where the queue looks fine and the work is gone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = join(__dirname, '../../../orchestrations/scripts/lib/webhook-queue.js');

function freshQueue() {
  delete require.cache[require.resolve(MODULE)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const queue = require(MODULE);
  const dir = mkdtempSync(join(tmpdir(), 'webhook-'));
  const queueFile = join(dir, 'queue.json');
  return { queue, dir, queueFile };
}

const evt = (over: Record<string, unknown> = {}) => ({
  projectKey: 'AMSD', jiraKey: 'AMSD-1', title: 'A ticket', ...over,
});

describe('the webhook queue loses no event', () => {
  beforeEach(() => { vi.useRealTimers(); });

  it('an event with NO projectKey is refused, and says so', () => {
    // It cannot be grouped, so it cannot be flushed. Silently keeping it would be a event that
    // never triggers anything and never appears as a problem.
    const { queue, queueFile } = freshQueue();
    queue.init({ queueFile, debounceMs: 10_000 });
    queue.enqueue({ jiraKey: 'AMSD-1' });
    queue.enqueue(null);
    expect(queue.loadQueue(), 'an ungroupable event was persisted anyway').toEqual({});
  });

  it('PERSISTS each event immediately, so a restart loses nothing', () => {
    // The queue exists to survive control-plane restarts. If persistence happened only at flush,
    // every event inside an open debounce window would be lost on restart.
    const { queue, queueFile } = freshQueue();
    queue.init({ queueFile, debounceMs: 10_000 });
    queue.enqueue(evt());
    expect(existsSync(queueFile), 'nothing was written to disk before the window closed').toBe(true);
    const onDisk = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(onDisk.AMSD.events).toHaveLength(1);
    expect(onDisk.AMSD.events[0].jiraKey).toBe('AMSD-1');
    expect(onDisk.AMSD.events[0].receivedAt, 'the event carries no arrival time').toBeTruthy();
  });

  it('and a NEW process reads that queue back — the whole point of persisting', () => {
    const { queue, queueFile } = freshQueue();
    queue.init({ queueFile, debounceMs: 10_000 });
    queue.enqueue(evt());
    // A restart: fresh module instance, same file.
    const { queue: revived } = freshQueue();
    revived.init({ queueFile, debounceMs: 10_000 });
    expect(revived.loadQueue().AMSD.events, 'a restart lost the queued events').toHaveLength(1);
  });

  it('groups by projectKey — one project flushing does not take another with it', () => {
    const { queue, queueFile, dir } = freshQueue();
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 10_000 });
    queue.enqueue(evt({ projectKey: 'AAA', jiraKey: 'AAA-1' }));
    queue.enqueue(evt({ projectKey: 'BBB', jiraKey: 'BBB-1' }));
    queue.flush('AAA');
    const left = queue.loadQueue();
    expect(left.AAA, 'the flushed project was left in the queue').toBeUndefined();
    expect(left.BBB.events, "another project's events were flushed away").toHaveLength(1);
  });

  it('an URGENT event bypasses the window and flushes at once', () => {
    const { queue, queueFile, dir } = freshQueue();
    const flushed: string[] = [];
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 10_000, onFlush: (k: string) => flushed.push(k) });
    queue.enqueue(evt());
    expect(flushed, 'a non-urgent event flushed immediately, defeating the debounce').toEqual([]);
    queue.enqueue(evt({ jiraKey: 'AMSD-2', urgent: true }));
    expect(flushed, 'an urgent event waited for the debounce window').toEqual(['AMSD']);
    expect(queue.loadQueue().AMSD, 'the urgent flush left the bucket behind').toBeUndefined();
  });

  it('and the urgent flush carries the events queued BEFORE it, not just itself', () => {
    // Flushing only the urgent event would silently drop everything already waiting.
    const { queue, queueFile, dir } = freshQueue();
    let prdPath = '';
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 10_000,
      onFlush: (_k: string, p: string) => { prdPath = p; } });
    queue.enqueue(evt({ jiraKey: 'AMSD-1' }));
    queue.enqueue(evt({ jiraKey: 'AMSD-2' }));
    queue.enqueue(evt({ jiraKey: 'AMSD-3', urgent: true }));
    expect(prdPath, 'no PRD was written').toBeTruthy();
    const body = readFileSync(prdPath, 'utf8');
    for (const k of ['AMSD-1', 'AMSD-2', 'AMSD-3']) {
      expect(body, `${k} was queued and then dropped by the urgent flush`).toContain(k);
    }
  });

  it('the debounce COLLAPSES a burst into one flush, and each event resets the window', () => {
    vi.useFakeTimers();
    const { queue, queueFile, dir } = freshQueue();
    const flushed: string[] = [];
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 1000, onFlush: (k: string) => flushed.push(k) });
    queue.enqueue(evt({ jiraKey: 'AMSD-1' }));
    vi.advanceTimersByTime(900);
    queue.enqueue(evt({ jiraKey: 'AMSD-2' }));   // resets the window
    vi.advanceTimersByTime(900);
    expect(flushed, 'the window did not reset on a new event').toEqual([]);
    vi.advanceTimersByTime(200);
    expect(flushed, 'the burst never flushed at all').toEqual(['AMSD']);
    expect(flushed.length, 'a burst produced more than one orchestration trigger').toBe(1);
    vi.useRealTimers();
  });

  it('flushing an EMPTY key writes no PRD and reports nothing to flush', () => {
    const { queue, queueFile, dir } = freshQueue();
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 10_000 });
    expect(queue.flush('NOPE'), 'a PRD was written for a project with no events').toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith('webhook-prd-'))).toEqual([]);
  });

  it('a CORRUPT queue file reads as empty rather than crashing the control plane', () => {
    // The queue is read on every enqueue. A crash here takes down the process that receives
    // webhooks, so every later event is lost too.
    const { queue, queueFile, dir } = freshQueue();
    writeFileSync(queueFile, '{ not json');
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 10_000 });
    expect(() => queue.enqueue(evt()), 'a corrupt queue file crashed the enqueue path').not.toThrow();
    expect(queue.loadQueue().AMSD.events, 'the event was lost recovering from corruption')
      .toHaveLength(1);
  });

  it('with no queue file configured at all it still does not throw', () => {
    const { queue } = freshQueue();
    queue.init({});
    expect(() => queue.enqueue(evt())).not.toThrow();
    expect(queue.loadQueue()).toEqual({});
  });

  it('the flushed PRD is named for the project, so two projects cannot overwrite each other', () => {
    const { queue, queueFile, dir } = freshQueue();
    queue.init({ queueFile, prdOutDir: dir, debounceMs: 10_000 });
    queue.enqueue(evt({ projectKey: 'AAA', jiraKey: 'AAA-1', urgent: true }));
    queue.enqueue(evt({ projectKey: 'BBB', jiraKey: 'BBB-1', urgent: true }));
    const written = readdirSync(dir).filter((f) => f.startsWith('webhook-prd-'));
    expect(written.length, 'one project overwrote the other PRD').toBe(2);
    expect(written.join(' ')).toMatch(/AAA/);
    expect(written.join(' ')).toMatch(/BBB/);
  });
});
