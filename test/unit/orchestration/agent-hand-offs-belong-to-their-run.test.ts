/**
 * AGENT HAND-OFFS BELONG TO THEIR RUN — THERE IS NO MACHINE-WIDE STORE.
 *
 * The agent-io store (lib/agent-io.js) carries every hand-off between agents — attempt evidence,
 * fix plans, findings. It lived under LOG_DIR "so an input surviving into the next run" could not
 * happen, but fell back to /tmp/agent-io whenever LOG_DIR was not in the environment. claude.sh
 * sets LOG_DIR without exporting it, so every claude.sh started directly (the one-story harness —
 * both paid REGI-009a runs of 2026-09-24 — and the frozen-state POC) read and wrote ONE directory
 * shared by every run, project and process on the machine. The POC's first attempt was handed an
 * "attempt-evidence" the previous POC run had written, and /tmp/agent-io held the live run's
 * REGI-005-A and REGI-007 hand-offs hours later.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = []; afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aio-')); dirs.push(d); return d; };

/** Publish through the real shell binding, with a chosen environment. */
function publish(env: Record<string, string>, story: string) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(join(LIB, 'agent-io.sh'))}; publish_agent_output engine attempt-evidence ${story} "the evidence"; echo "rc=$?"`],
    { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } });
  return { out: (r.stdout || '') + (r.stderr || '') };
}

describe('agent hand-offs belong to their run', () => {
  it('with LOG_DIR in the environment, a hand-off lands under that run\'s logs', () => {
    const logs = tmp(); const story = `AIO-${Date.now()}`;
    publish({ LOG_DIR: logs }, story);
    expect(readFileSync(join(logs, 'agent-io', story, 'attempt-evidence'), 'utf8')).toBe('the evidence');
  });

  it('with NO run to belong to, it refuses loudly — nothing lands in a machine-wide /tmp/agent-io', () => {
    const story = `AIO-NORUN-${Date.now()}`;
    const r = publish({}, story);
    expect(existsSync(join('/tmp/agent-io', story)), 'a hand-off was written to the machine-wide store').toBe(false);
    expect(r.out).toMatch(/LOG_DIR|no run/i);
  });

  it('claude.sh exports LOG_DIR — so every child it starts (the store, the writer, the analysts) is in its run', () => {
    // The assignment and the export, executed: source nothing else, run the two lines claude.sh has.
    const src = readFileSync(CLAUDE_SH, 'utf8').split('\n');
    const i = src.findIndex((l) => /^LOG_DIR="\$AUTOMATION_DIR\/logs"/.test(l));
    expect(i, 'claude.sh no longer sets LOG_DIR on its own line — find it before trusting this').toBeGreaterThan(0);
    const block = src.slice(i, i + 3).join('\n');
    const r = spawnSync('bash', ['-c', `AUTOMATION_DIR=/x\n${block}\nbash -c 'echo "child sees [$LOG_DIR]"'`], { encoding: 'utf8', env: { PATH: process.env.PATH! } });
    expect(r.stdout.trim()).toBe('child sees [/x/logs]');
  });
});
