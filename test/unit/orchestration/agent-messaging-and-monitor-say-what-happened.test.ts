/**
 * AGENT MESSAGING AND THE RUN MONITOR — 360 lines between them, none with a test.
 *
 * These are how a run says what it is doing. The monitor file is what the dashboards read, and the
 * message inbox is how one agent reaches another. Both fail the same quiet way: a message that is
 * never delivered, or a status that is never updated, produces no error — the run simply looks
 * different from what it is, and the operator watching the dashboard is watching a lie.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(S, script), ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('a message reaches its recipient, or the sender is told', () => {
  const msgs = () => mkdtempSync(join(tmpdir(), 'msgs-'));

  it('a sent message lands in the recipient inbox', () => {
    const dir = msgs();
    const r = run('send-message.sh', ['--from', 'a', '--to', 'b', '--type', 'info',
      '--subject', 's', '--text', 't'], { MESSAGES_DIR: dir });
    expect(r.code, r.out.slice(0, 300)).toBe(0);
    const inbox = join(dir, 'inbox/b');
    expect(existsSync(inbox), 'nothing was delivered to the recipient').toBe(true);
    expect(readdirSync(inbox).length, 'the inbox is empty after a successful send')
      .toBeGreaterThan(0);
  }, 180_000);

  it('and the message carries who sent it, to whom, and what it says', () => {
    const dir = msgs();
    run('send-message.sh', ['--from', 'reviewer', '--to', 'writer', '--type', 'rejection',
      '--subject', 'needs work', '--text', 'the tests do not run'], { MESSAGES_DIR: dir });
    const inbox = join(dir, 'inbox/writer');
    const body = readFileSync(join(inbox, readdirSync(inbox)[0]), 'utf8');
    for (const field of ['reviewer', 'writer', 'rejection', 'needs work', 'the tests do not run']) {
      expect(body, `the message does not carry "${field}"`).toContain(field);
    }
  }, 180_000);

  it('a MISSING required field is refused rather than sent half-formed', () => {
    // A message with no recipient is not a message; delivering it nowhere silently is worse than
    // refusing, because the sender believes it was said.
    const dir = msgs();
    for (const missing of [['--from', 'a'], ['--to', 'b'], ['--type', 'info']]) {
      const args = ['--from', 'a', '--to', 'b', '--type', 'info', '--subject', 's', '--text', 't'];
      const i = args.indexOf(missing[0]);
      const without = [...args.slice(0, i), ...args.slice(i + 2)];
      const r = run('send-message.sh', without, { MESSAGES_DIR: dir });
      expect(r.code, `a message without ${missing[0]} was sent anyway`).not.toBe(0);
    }
  }, 180_000);

  it('receiving an EMPTY inbox is not an error — a quiet agent is normal', () => {
    const dir = msgs();
    const r = run('receive-messages.sh', ['nobody'], { MESSAGES_DIR: dir });
    expect(r.code, 'an agent with no messages was treated as a failure').toBe(0);
  }, 180_000);

  it('a sent message is then RECEIVED — the two halves meet', () => {
    // Either half can look fine alone: a send that writes nowhere, or a receive that reads the wrong
    // directory. Only the round trip proves the seam.
    const dir = msgs();
    run('send-message.sh', ['--from', 'a', '--to', 'b', '--type', 'info',
      '--subject', 'hello', '--text', 'world'], { MESSAGES_DIR: dir });
    const r = run('receive-messages.sh', ['b'], { MESSAGES_DIR: dir });
    expect(r.out, 'the message that was sent did not come back out').toContain('hello');
  }, 180_000);

  it('receiving with NO agent id is refused rather than reading someone else inbox', () => {
    const r = run('receive-messages.sh', [], { MESSAGES_DIR: msgs() });
    expect(r.code).not.toBe(0);
  }, 180_000);
});

describe('the monitor file says what the run is really doing', () => {
  const monitor = () => join(mkdtempSync(join(tmpdir(), 'monitor-')), 'agent-status.json');

  it('init creates the file the dashboards read', () => {
    const f = monitor();
    const r = run('update-monitor.sh', ['init', 'core'], { MONITOR_FILE: f });
    expect(r.code, r.out.slice(0, 300)).toBe(0);
    expect(existsSync(f), 'the monitor file the dashboards read was never created').toBe(true);
    expect(() => JSON.parse(readFileSync(f, 'utf8')), 'the monitor file is not valid JSON')
      .not.toThrow();
  }, 180_000);

  it('a started story appears, and a completed one is marked complete', () => {
    // The dashboard shows what is running now. A story that starts and never appears is a run the
    // operator cannot watch.
    const f = monitor();
    run('update-monitor.sh', ['init', 'core'], { MONITOR_FILE: f });
    run('update-monitor.sh', ['story_start', 'S-1', 'laneA', 'writer', 'A title'], { MONITOR_FILE: f });
    let doc = readFileSync(f, 'utf8');
    expect(doc, 'a started story is not in the monitor').toContain('S-1');
    run('update-monitor.sh', ['story_complete', 'S-1', 'laneA'], { MONITOR_FILE: f });
    doc = readFileSync(f, 'utf8');
    expect(doc, 'the completed story left no completion record').toMatch(/complet/i);
  }, 180_000);

  it('a FAILED story records its error, not just its failure', () => {
    // "It failed" sends the operator to the logs; the error sends them to the cause.
    const f = monitor();
    run('update-monitor.sh', ['init', 'core'], { MONITOR_FILE: f });
    run('update-monitor.sh', ['story_fail', 'S-2', 'laneA', 'tsc exploded'], { MONITOR_FILE: f });
    expect(readFileSync(f, 'utf8'), 'the failure reason was discarded').toContain('tsc exploded');
  }, 180_000);

  it('an UNKNOWN event type is refused rather than silently recorded as nothing', () => {
    const f = monitor();
    run('update-monitor.sh', ['init', 'core'], { MONITOR_FILE: f });
    const r = run('update-monitor.sh', ['not_an_event', 'x'], { MONITOR_FILE: f });
    expect(r.code, 'an unknown event was accepted, so a typo would silently update nothing')
      .not.toBe(0);
  }, 180_000);

  it('the file stays valid JSON after several updates — the dashboards parse it', () => {
    // A monitor file that stops parsing takes every dashboard down with it, mid-run.
    const f = monitor();
    run('update-monitor.sh', ['init', 'core'], { MONITOR_FILE: f });
    for (const id of ['S-1', 'S-2', 'S-3']) {
      run('update-monitor.sh', ['story_start', id, 'laneA', 'writer', `title ${id}`], { MONITOR_FILE: f });
      run('update-monitor.sh', ['story_complete', id, 'laneA'], { MONITOR_FILE: f });
    }
    expect(() => JSON.parse(readFileSync(f, 'utf8')),
      'the monitor file stopped parsing after several updates').not.toThrow();
  }, 180_000);
});
