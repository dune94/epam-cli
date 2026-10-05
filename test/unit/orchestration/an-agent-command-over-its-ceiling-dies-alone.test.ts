/**
 * AN AGENT'S COMMAND OVER ITS CEILING DIES ALONE — THE RUN AND THE AGENT CARRY ON.
 *
 * Live 2026-10-05, AMSD-2974 writer on copilot: the agent's shell tool ran a bare `npx jest` (a worker
 * per core) and the RUN's scope was OOM-killed. The copilot call now runs in its own memory scope
 * (scripts/run-bounded.sh). Proven with real copilot agents, and each shape below failed there first:
 *   - a throttle band (MemoryHigh) with swap 0 FROZE the command at 1536MB; the call hung to timeout;
 *   - the scope's default OOMPolicy (stop) killed the agent WITH its command: an empty answer;
 *   - an `env` prefix resolved to uv's ~/.local/bin/env, which ran nothing: "said nothing".
 *
 * EXECUTED: the real provider_call with a stand-in CLI that records the scope it runs in, starts a
 * child that allocates without end, and then answers. Real systemd user scopes, real OOM killer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations');
const DIR = join(ORCH, 'plugins/providers/copilot');
const work = mkdtempSync(join(tmpdir(), 'agent-scope-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const hasUserScopes = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout.trim() !== '';

const scopeOut = join(work, 'scope.txt');
const childOut = join(work, 'child.txt');
const grow = 'const a=[];for(;;)a.push(Buffer.alloc(32*1024*1024,1))';
const stub = join(work, 'cli.sh');
writeFileSync(stub, [
  '#!/bin/bash',
  'cat >/dev/null',
  `cut -d: -f3 /proc/self/cgroup > ${JSON.stringify(scopeOut)}`,
  `${JSON.stringify(process.execPath)} -e '${grow}' 2>/dev/null; echo "$?" > ${JSON.stringify(childOut)}`,
  `echo '{"type":"assistant.message","data":{"content":"the command was killed"}}'`,
  '',
].join('\n'));
chmodSync(stub, 0o755);
// The uv-style shadow: an `env` first on PATH that runs nothing.
const shadow = join(work, 'shadow'); mkdirSync(shadow);
writeFileSync(join(shadow, 'env'), '#!/bin/sh\nexport UV_SHADOW=1\n'); chmodSync(join(shadow, 'env'), 0o755);
const prompt = join(work, 'prompt.txt'); writeFileSync(prompt, 'hi');
const home = join(work, 'home'); mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'catalog.json'), '{}');

function call(bounded: '0' | '1') {
  for (const f of [scopeOut, childOut]) rmSync(f, { force: true });
  const env: Record<string, string> = {
    ...(process.env as any), COPILOT_CMD: stub, EPAM_COPILOT_HOME: home, NODE_BIN: process.execPath,
    EPAM_PROVIDER_SET: 'copilot', EPAM_AGENT_BOUNDED: bounded, EPAM_AGENT_MEMORY_SHARE: '3',
    PATH: `${shadow}:${process.env.PATH}`,
  };
  delete env.LOG_DIR;
  const r = spawnSync('bash', ['-c',
    `cd ${JSON.stringify(DIR)} && source ./runner.sh && provider_call ${JSON.stringify(prompt)} ${JSON.stringify(join(work, 'r.json'))}; echo "CALLER rc=$? scope=$(cut -d: -f3 /proc/self/cgroup)"`],
    { encoding: 'utf8', env, timeout: 90_000 });
  const caller = /CALLER rc=(\d+) scope=(\S+)/.exec(r.stdout ?? '');
  return {
    ran: existsSync(scopeOut), r, callerAlive: !!caller, callerScope: caller?.[2],
    agentScope: existsSync(scopeOut) ? readFileSync(scopeOut, 'utf8').trim() : '',
    childExit: existsSync(childOut) ? readFileSync(childOut, 'utf8').trim() : '',
  };
}

describe.runIf(hasUserScopes)('an agent call runs in its own memory scope', () => {
  it('bounded: the CLI runs (no env shadowing), in a scope of its own; its runaway child is killed and the CLI answers; the caller survives', () => {
    const c = call('1');
    expect(c.ran, `the CLI never ran: ${(c.r.stderr ?? '').slice(-600)}`).toBe(true);
    expect(c.callerAlive, `the caller did not survive: ${(c.r.stderr ?? '').slice(-600)}`).toBe(true);
    expect(c.agentScope).toMatch(/\.scope$/);
    expect(c.agentScope, 'the agent ran in the caller\'s own scope').not.toBe(c.callerScope);
    expect(c.childExit, 'the runaway child was not killed by the ceiling (137)').toBe('137');
    expect(readFileSync(join(work, 'r.json'), 'utf8')).toContain('the command was killed');
  }, 120_000);

  it('EPAM_AGENT_BOUNDED=0: the CLI runs in the caller\'s scope (the control)', () => {
    rmSync(join(work, 'r.json'), { force: true });
    // The control must not allocate without end in the caller's scope: a stub that only records.
    const plain = join(work, 'plain.sh');
    writeFileSync(plain, `#!/bin/bash\ncat >/dev/null\ncut -d: -f3 /proc/self/cgroup > ${JSON.stringify(scopeOut)}\n`);
    chmodSync(plain, 0o755);
    rmSync(scopeOut, { force: true });
    const r = spawnSync('bash', ['-c',
      `cd ${JSON.stringify(DIR)} && source ./runner.sh && provider_call ${JSON.stringify(prompt)} ${JSON.stringify(join(work, 'r.json'))}; cut -d: -f3 /proc/self/cgroup`],
      { encoding: 'utf8', timeout: 60_000, env: { ...(process.env as any), COPILOT_CMD: plain, EPAM_COPILOT_HOME: home, NODE_BIN: process.execPath, EPAM_PROVIDER_SET: 'copilot', EPAM_AGENT_BOUNDED: '0' } });
    expect(existsSync(scopeOut), `the CLI never ran: ${(r.stderr ?? '').slice(-600)}`).toBe(true);
    expect(readFileSync(scopeOut, 'utf8').trim()).toBe((r.stdout ?? '').trim().split('\n').pop());
  }, 90_000);
});
