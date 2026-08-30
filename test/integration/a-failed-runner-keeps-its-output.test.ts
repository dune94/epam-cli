/**
 * A RUNNER THAT EXITS NON-ZERO STILL SAID SOMETHING, AND IT IS THROWN AWAY.
 *
 * runClaude captures stdout and stderr, and on a non-zero exit rejects with
 *
 *     prompt runner exited with code 1
 *
 * discarding everything the child actually wrote. The caller then reports that sentence and
 * nothing else.
 *
 * Live, three paid runs on the same ticket: the roster specialiser failed 3 attempts out of 3 with
 * exactly that message, no log file, no captured reply, nothing on disk — because the failure path
 * keeps none of it. The cause is still unknown after three runs, which is the cost of discarding
 * evidence at the one moment it matters.
 *
 * The reply of a FAILING call is worth more than the reply of a passing one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runner = require('../../orchestrations/scripts/spec-mode-runner.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const CRY = 'ENOENT: cannot open the roster destination for writing';

/** A runner that explains itself on stderr and then fails, as a real one does. */
function failingRunner() {
  const dir = mkdtempSync(join(tmpdir(), 'failrun-')); dirs.push(dir);
  const sh = join(dir, 'run.sh');
  writeFileSync(sh, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    `echo ${JSON.stringify(CRY)} >&2`,
    'exit 1',
  ].join('\n'));
  chmodSync(sh, 0o755);
  return { cmd: sh, args: [] as string[], dir };
}

describe('a failed runner keeps its output', () => {
  it('the rejection carries what the runner said, not just its exit code', async () => {
    const spec = failingRunner();
    let message = '';
    try {
      await runner.runClaude(spec, 'a prompt', null, {}, { costAgent: 'failing-test' });
    } catch (e: any) {
      message = String((e && e.message) || e);
    }
    expect(message, 'the call did not fail at all').toContain('code 1');
    expect(message, "the runner's own explanation was discarded — this is why three paid runs "
      + 'failed at the same stage with nothing to read').toContain(CRY);
  }, 60_000);

  it('and keeps it on disk, where a failure can be read after the run', async () => {
    const store = mkdtempSync(join(tmpdir(), 'replies-')); dirs.push(store);
    const prev = process.env.EPAM_AGENT_REPLY_LOG_DIR;
    process.env.EPAM_AGENT_REPLY_LOG_DIR = store;
    try {
      const spec = failingRunner();
      try {
        await runner.runClaude(spec, 'a prompt', null, {}, { costAgent: 'failing-test' });
      } catch { /* expected */ }
      const files = readdirSync(store);
      expect(files.length, 'a failing call left nothing on disk').toBeGreaterThan(0);
      const body = files.map((f) => readFileSync(join(store, f), 'utf8')).join('\n');
      expect(body).toContain(CRY);
    } finally {
      if (prev === undefined) delete process.env.EPAM_AGENT_REPLY_LOG_DIR;
      else process.env.EPAM_AGENT_REPLY_LOG_DIR = prev;
    }
  }, 60_000);
});
